export function stringArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

export function requiredArg(name: string): string {
  const v = stringArg(name);
  if (!v) throw new Error(`--${name}=... is required`);
  return v;
}
