import { client, required } from './client.js';

// Supply an OCI image-layout tar for Linux amd64, not an ISO or arbitrary tar.
const image = await client.presets.upload({
  file: required('PUTERED_IMAGE_FILE'),
  name: 'image-' + Date.now(),
  onOperation: id => console.log('Upload operation ID:', id),
  onProgress: ({ completedBytes, totalBytes }) => console.log(`${completedBytes}/${totalBytes} bytes`),
});
console.log('Image ID:', image.id, 'Bytes:', image.bytes);

const environment = await client.environments.create({
  template: image.id,
  settings: { saveScope: 'entire-environment', network: { mode: 'disabled' } },
});
console.log('Created environment:', environment.id);
// Keep this configured environment. Use example 11 when finished.
// The uploaded image is a separate resource; delete it in the Snapshots console.
