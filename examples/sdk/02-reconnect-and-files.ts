import { client, required } from './client.js';

const environment = await client.environments.connect(required('PUTERED_ENVIRONMENT_ID'));
console.log('Connected:', environment.id);

// Run after example 01: greeting.txt is already in the saved workspace.
process.stdout.write((await environment.exec('cat greeting.txt')).output);
await environment.exec("printf 'Written during a later request\n' >> greeting.txt");
process.stdout.write((await environment.exec('cat greeting.txt')).output);

// describe() is cached configuration, not a live status request.
console.log('Save scope:', environment.describe().settings.saveScope);
