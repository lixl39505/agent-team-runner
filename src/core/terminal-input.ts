import type { Readable, Writable } from 'node:stream';

interface TtyInput extends Readable {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
}

interface TtyOutput extends Writable {
  isTTY?: boolean;
}

/** Reads a secret without echoing its characters to the terminal. */
export function promptMaskedSecret(message: string, input: TtyInput = process.stdin, output: TtyOutput = process.stdout): Promise<string> {
  if (!input.isTTY || !output.isTTY || !input.setRawMode) {
    return Promise.reject(new Error('API key entry requires an interactive terminal.'));
  }
  output.write(message);
  input.setRawMode(true);
  input.resume();
  let value = '';
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      for (const character of text) {
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u0003') return finish(new Error('API key entry cancelled.'));
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          value += character;
        }
      }
    };
    input.on('data', onData);
  });
}
