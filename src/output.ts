export function writeSuccess(value: string): void {
  process.stdout.write(`${value}\n`);
}

export function writeDiagnostic(message: string): void {
  process.stderr.write(`${message}\n`);
}
