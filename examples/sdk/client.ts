import { Putered } from '@putered/sdk';

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running this example.`);
  return value;
}

export const client = new Putered({
  apiKey: required('PUTERED_API_KEY'),
  config: {},
});

// Quote data as one shell argument, including embedded single quotes.
export const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
