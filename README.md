# Multi Zip Reader

NodeJS library designed for fast access to arbitrary files across an arbitrary number of read only zip files.
Supports reading back files as streams or into a returned buffer.

Supports:
- Zip64 files (>4GB)
- Store and Deflate compression
- Reading files into buffers or streams

## Example

```typescript
import { MultiZipReader } from '@fparchive/multi-zip-reader';

async function run() {
  // Loads all .zip files in the current directory
  const reader = new MultiZipReader();
  await reader.loadDirectory('./'); 

  // Read file back as a buffer
  const fileData = await reader.readFile("image.png")
  
  // Read file back as stream
  const stream = await reader.readFileStream("image.png");
  // No stream is an empty file, no content
  if (stream === null) {
  }
}
```