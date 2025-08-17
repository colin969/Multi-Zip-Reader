import { FpArchiveDataManager } from "./src/MultiZipReader";
import * as path from 'path';
import * as fs from 'fs';

const testDir = "G:\\Data\\Flashpoint\\Data\\ArchiveData\\Htdocs_6.zip";
const testUncompressedDir = "G:\\Data\\Flashpoint\\Data\\ArchiveData\\Uncompressed";

async function benchmarkZipParse(iterations: number): Promise<number> {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const archive = new FpArchiveDataManager();
    for (const file of fs.readdirSync(testDir, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith('.zip'))) {
      await archive.loadArchive(path.join(testDir, file.name), false);
    }
  }
  const end = performance.now();
  return end - start;
}

async function readFromDisk(archive: FpArchiveDataManager) {
  console.log('Reading all files from disk...');
  console.log('=== Reading from Disk ===');
  let readData = 0;
  const names = Object.keys(archive.data);
  const startReadUncompressed = performance.now();

  for (const key of names) {
    const filePath = path.join(testUncompressedDir, key);
    const stream = fs.createReadStream(filePath);
    // Read stream into memory as buffer
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
      readData += chunk.length;
    }
    const fileContent = Buffer.concat(chunks);

    stream.destroy();
  }

  const endReadUncompressed = performance.now();

  const uncompressedTimeMs = endReadUncompressed - startReadUncompressed;
  const uncompressedTimeSec = uncompressedTimeMs / 1000;
  const uncompressedReadMB = readData / (1024 * 1024);
  const uncompressedMbPerSec = uncompressedReadMB / (uncompressedTimeSec);
  console.log(`Read ${names.length} files in ${uncompressedTimeMs.toFixed(0)}ms (${(names.length / uncompressedTimeSec).toFixed(2)} Files/sec, ${uncompressedReadMB.toFixed(0)} MB at ${uncompressedMbPerSec.toFixed(2)} MB/s)`)

}

async function readFromZip(archive: FpArchiveDataManager) {
  console.log('Reading all files from zip offsets...');
  console.log('=== Reading from Zip Offset ===');
  let readData = 0;
  const names = Object.keys(archive.data);
  const startRead = performance.now();

  for (const key of names) {
    const stream = await archive.readFile(key);
    if (stream) {
      if (stream.length === 0) {
        // 0 size file, no data to read
        continue;
      }
      // Read stream into memory as buffer
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
        readData += chunk.length;
      }
      const fileContent = Buffer.concat(chunks);
      if (fileContent.length !== stream.length) {
        throw new Error(`Failed read len found ${fileContent.length} - expected ${stream.length}`);
      }

      stream.close();
    } else {
      throw new Error('Failed read');
    }
  }
  const endRead = performance.now();

  const timeMs = endRead - startRead;
  const timeSec = timeMs / 1000;
  const readMB = readData / (1024 * 1024);
  const mbPerSec = readMB / (timeSec);

  console.log(`Read ${names.length} files in ${timeMs.toFixed(0)}ms (${(names.length / timeSec).toFixed(2)} Files/sec, ${readMB.toFixed(0)} MB at ${mbPerSec.toFixed(2)} MB/s)`)
}

async function benchmarkZipRead(): Promise<void> {
  const archive = new FpArchiveDataManager();
  const start = performance.now();
  for (const file of fs.readdirSync(testDir, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith('.zip'))) {
    await archive.loadArchive(path.join(testDir, file.name), false);
  }
  const end = performance.now();
  const timeMs = end - start;

  // Calculate average index time
  const indexTotal = Object.keys(archive.data).length;
  const filesPerSecond = indexTotal / timeMs;
  console.log(`Indexed ${indexTotal.toLocaleString()} Files in ${(timeMs / 1000).toFixed(0)} seconds (${filesPerSecond.toFixed(0)} Files/sec)`)

  // await readFromDisk(archive);
  // await readFromZip(archive);
}

async function run() {
  await benchmarkZipRead();
}

run();

