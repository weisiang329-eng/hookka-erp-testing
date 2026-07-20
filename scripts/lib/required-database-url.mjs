export function requiredDatabaseUrl(name, env = process.env) {
  const value = String(env[name] ?? "").trim();
  if (!value) {
    throw new Error(
      `${name} is required; database scripts never fall back to an embedded or default target.`,
    );
  }
  return value;
}
