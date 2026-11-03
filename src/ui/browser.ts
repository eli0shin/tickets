/** Browser launch is best-effort; failure must not stop the local server. */
export async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd.exe', '/c', 'start', '', url]
        : ['xdg-open', url];
  const child = Bun.spawn(command, {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  child.unref();
  if ((await child.exited) !== 0)
    throw new Error('Browser launcher exited unsuccessfully');
}
