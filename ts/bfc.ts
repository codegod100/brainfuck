import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { basename } from 'path';

enum Mode {
  COMPILE = 1 << 0,
  ASSEMBLE = 1 << 1,
  LINK = 1 << 2,
  PIPE_OUT = 1 << 3,
  PIPE_IN = 1 << 4,
  VERBOSE = 1 << 5
}

interface Options {
  stackSize: number;
  arraySize: number;
  outputFile: string | null;
  inputFile: string | null;
  mode: Mode;
}

type ParseResult = { kind: 'ok'; options: Options } | { kind: 'help' } | { kind: 'error'; message: string };

const DEFAULT_STACK_SIZE = 1000;
const DEFAULT_ARRAY_SIZE = 1000;

function isUint(str: string): boolean {
  return /^\d+$/.test(str);
}

function printHelp(): void {
  const lines = [
    'Usage: bfc [input file] [options]',
    '',
    '\t-s [NUMBER]     sets the stack size to this number',
    '\t-a [ARRSIZE]    sets the array size in the program to this number',
    '\t-c              only compile and assemble',
    '\t-S              only compile',
    '\t-o [FILE]       specify an output file',
    '\t-v              enable verbose output',
    '\t-h, --help      print this help message',
    '\t-i              get input from stdin',
    '\t-pipe           pipe to assembler if -S is not set, otherwise print to stdout',
    ''
  ];
  lines.forEach((line) => process.stderr.write(`${line}\n`));
}

function parseArgs(argv: string[]): ParseResult {
  let mode: Mode = Mode.COMPILE | Mode.ASSEMBLE | Mode.LINK;
  let stackSize = DEFAULT_STACK_SIZE;
  let arraySize = DEFAULT_ARRAY_SIZE;
  let outputFile: string | null = null;
  let inputFile: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-s') {
      const value = argv[++i];
      if (!value || !isUint(value)) {
        const prog = basename(process.argv[1] ?? 'bfc');
        return { kind: 'error', message: `${prog}: option requires a numerical argument -- 's'` };
      }
      stackSize = Number.parseInt(value, 10);
    } else if (arg === '-a') {
      const value = argv[++i];
      if (!value || !isUint(value)) {
        const prog = basename(process.argv[1] ?? 'bfc');
        return { kind: 'error', message: `${prog}: option requires a numerical argument -- 'a'` };
      }
      arraySize = Number.parseInt(value, 10);
    } else if (arg === '-c') {
      mode &= ~Mode.LINK;
    } else if (arg === '-S') {
      mode &= ~(Mode.LINK | Mode.ASSEMBLE);
    } else if (arg === '-o') {
      const value = argv[++i];
      if (!value) {
        const prog = basename(process.argv[1] ?? 'bfc');
        return { kind: 'error', message: `${prog}: option requires an argument -- 'o'` };
      }
      outputFile = value;
      mode &= ~Mode.PIPE_OUT;
    } else if (arg === '-v') {
      mode |= Mode.VERBOSE;
    } else if (arg === '-h' || arg === '--help') {
      return { kind: 'help' };
    } else if (arg === '-pipe') {
      mode |= Mode.PIPE_OUT;
    } else if (arg === '-i') {
      mode |= Mode.PIPE_IN;
    } else {
      inputFile = arg;
      mode &= ~Mode.PIPE_IN;
    }
  }

  return {
    kind: 'ok',
    options: { stackSize, arraySize, outputFile, inputFile, mode }
  };
}

function removeExtension(name: string): string {
  const dotIndex = name.lastIndexOf('.');
  const slashIndex = name.lastIndexOf('/');
  if (dotIndex <= slashIndex) {
    return name;
  }
  return name.slice(0, dotIndex);
}

function deriveAssemblyName(options: Options): string | null {
  if (options.mode & Mode.PIPE_OUT) {
    return null;
  }
  if (!(options.mode & Mode.ASSEMBLE) && options.outputFile) {
    return options.outputFile;
  }
  if (options.inputFile) {
    return `${removeExtension(options.inputFile)}.s`;
  }
  return 'a.out.s';
}

function deriveObjectName(options: Options): string {
  if (!(options.mode & Mode.LINK) && options.outputFile) {
    return options.outputFile;
  }
  if (options.inputFile) {
    return `${removeExtension(options.inputFile)}.o`;
  }
  return 'a.out.o';
}

function readSource(options: Options): string {
  if (!options.inputFile && !(options.mode & Mode.PIPE_IN)) {
    throw new Error('bfc: error: no input files\ncompilation terminated.');
  }
  if (options.mode & Mode.PIPE_IN) {
    const buf = readFileSync(0);
    return buf.toString('utf8');
  }
  try {
    const buf = readFileSync(options.inputFile as string);
    if (options.mode & Mode.VERBOSE) {
      process.stdout.write(`opening file ${options.inputFile}\n`);
    }
    return buf.toString('utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`error: couldn't open file ${options.inputFile}: ${message}`);
  }
}

function compileBrainfuck(source: string, stackSize: number, arraySize: number): string {
  let labelCounter = 0;
  let stackCapacity = Math.max(1, stackSize);
  const stack: number[] = new Array(stackCapacity);
  let stackPtr = 0;
  const lines: string[] = [];

  lines.push('\t.section .bss');
  lines.push(`\t.lcomm buffer ${arraySize}`);
  lines.push('');
  lines.push('\t.section .text');
  lines.push('\t.globl _start');
  lines.push('_start:');
  lines.push('\tmovl $buffer, %edi');
  lines.push('');

  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    switch (c) {
      case '>':
        lines.push('\tinc %edi');
        lines.push('');
        break;
      case '<':
        lines.push('\tdec %edi');
        lines.push('');
        break;
      case '+':
        lines.push('\tincb (%edi)');
        lines.push('');
        break;
      case '-':
        lines.push('\tdecb (%edi)');
        lines.push('');
        break;
      case '.':
        lines.push('\tmovl $4, %eax');
        lines.push('\tmovl $1, %ebx');
        lines.push('\tmovl %edi, %ecx');
        lines.push('\tmovl $1, %edx');
        lines.push('\tint $0x80');
        lines.push('');
        break;
      case ',':
        lines.push('\tmovl $3, %eax');
        lines.push('\tmovl $0, %ebx');
        lines.push('\tmovl %edi, %ecx');
        lines.push('\tmovl $1, %edx');
        lines.push('\tint $0x80');
        lines.push('');
        break;
      case '[': {
        if (stackPtr === stackCapacity) {
          stackCapacity *= 2;
          stack.length = stackCapacity;
        }
        labelCounter += 1;
        stack[stackPtr] = labelCounter;
        stackPtr += 1;
        lines.push('\tcmpb $0, (%edi)');
        lines.push(`\tjz .LE${labelCounter}`);
        lines.push(`.LB${labelCounter}:`);
        break;
      }
      case ']': {
        if (stackPtr === 0) {
          throw new Error('error: unmatched closing bracket');
        }
        stackPtr -= 1;
        const label = stack[stackPtr];
        lines.push('\tcmpb $0, (%edi)');
        lines.push(`\tjnz .LB${label}`);
        lines.push(`.LE${label}:`);
        break;
      }
      default:
        break;
    }
  }

  if (stackPtr !== 0) {
    throw new Error('error: unmatched opening bracket');
  }

  lines.push('\tmovl $1, %eax');
  lines.push('\tmovl $0, %ebx');
  lines.push('\tint $0x80');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function runCommand(command: string, args: string[], verbose: boolean, stdinData?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (verbose) {
      process.stdout.write(`running: ${command} ${args.join(' ')}\n`);
    }
    const stdio: Array<'pipe' | 'inherit'> = ['inherit', 'inherit', 'inherit'];
    if (stdinData !== undefined) {
      stdio[0] = 'pipe';
    }
    const child = spawn(command, args, { stdio });
    child.on('error', (err) => {
      reject(err);
    });
    if (stdinData !== undefined && child.stdin) {
      child.stdin.write(stdinData);
      child.stdin.end();
    }
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === 'help') {
    printHelp();
    return;
  }
  if (parsed.kind === 'error') {
    process.stderr.write(`${parsed.message}\n`);
    process.exitCode = 1;
    return;
  }

  const options = parsed.options;
  const verbose = (options.mode & Mode.VERBOSE) !== 0;

  let source: string;
  try {
    source = readSource(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  let assembly: string;
  try {
    assembly = compileBrainfuck(source, options.stackSize, options.arraySize);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  const assemblyPath = deriveAssemblyName(options);
  const objectPath = deriveObjectName(options);

  try {
    if (options.mode & Mode.PIPE_OUT) {
      if (options.mode & Mode.ASSEMBLE) {
        await runCommand('as', ['-g', '-o', objectPath], verbose, assembly);
      } else {
        process.stdout.write(assembly);
      }
    } else if (assemblyPath) {
      writeFileSync(assemblyPath, assembly, 'utf8');
    } else {
      throw new Error('internal error: expected assembly path');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  if (!(options.mode & Mode.ASSEMBLE)) {
    return;
  }

  if (!(options.mode & Mode.PIPE_OUT)) {
    try {
      await runCommand('as', [assemblyPath as string, '-g', '-o', objectPath], verbose);
      if (!(options.mode & Mode.LINK) && assemblyPath) {
        try {
          unlinkSync(assemblyPath);
        } catch (unlinkErr) {
          if (verbose) {
            const message = unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr);
            process.stderr.write(`warning: failed to remove ${assemblyPath}: ${message}\n`);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
      return;
    }
  }

  if (!(options.mode & Mode.LINK)) {
    return;
  }

  const ldArgs = [objectPath];
  if (options.outputFile) {
    ldArgs.push('-o', options.outputFile);
  }

  try {
    await runCommand('ld', ldArgs, verbose);
    try {
      unlinkSync(objectPath);
    } catch (unlinkErr) {
      if (verbose) {
        const message = unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr);
        process.stderr.write(`warning: failed to remove ${objectPath}: ${message}\n`);
      }
    }
    if ((options.mode & Mode.PIPE_OUT) === 0 && assemblyPath) {
      try {
        unlinkSync(assemblyPath);
      } catch (unlinkErr) {
        if (verbose) {
          const message = unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr);
          process.stderr.write(`warning: failed to remove ${assemblyPath}: ${message}\n`);
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

void main();
