// Integration tests run against their own database (`<dev db>_test`) so they
// can never touch real data — e.g. the reminder dispatcher sends *every* due
// reminder in the database it's pointed at.
export function testDatabaseUrl(devUrl: string): string {
  const url = new URL(devUrl);
  const name = url.pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) url.pathname = `/${name}_test`;
  return url.toString();
}
