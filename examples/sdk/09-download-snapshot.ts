import { client, required } from './client.js';

const snapshots = await client.presets.list();
console.table(snapshots.map(({ id, name, bytes }) => ({ id, name, bytes })));

const snapshot = await client.presets.download(required('PUTERED_SNAPSHOT_ID'), {
  destination: required('PUTERED_DOWNLOAD_FILE'),
});
console.log('Downloaded:', snapshot.id, 'Bytes:', snapshot.bytes);
// The SDK verifies the archive checksum and refuses to overwrite an existing file.
