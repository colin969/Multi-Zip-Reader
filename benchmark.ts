import { FpArchiveDataManager } from './src/MultiZipReader';
import { crc32 } from 'zlib';
import * as path from 'path';
import * as fs from 'fs';

const testDir = "G:\\Data\\Flashpoint\\Data\\ArchiveData";
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

async function benchmarkZipRead(): Promise<void> {
  const archive = new FpArchiveDataManager();
  const start = performance.now();
  for (const file of fs.readdirSync(testDir, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith('.zip'))) {
    await archive.loadArchive(path.join(testDir, file.name), false);
  }
  const end = performance.now();
  const timeMs = end - start;

  // Calculate average index time
  let indexTotal = 0;
  for (const source of archive.sources) {
    indexTotal += Object.keys(source.data).length;
  }
  const filesPerSecond = indexTotal / timeMs;
  console.log(`Indexed ${indexTotal.toLocaleString()} Files in ${timeMs.toFixed(0)}ms (${filesPerSecond.toFixed(0)} Files/sec)`)
}

async function testZipRead(): Promise<void> {
  const archive = new FpArchiveDataManager();
  for (const file of fs.readdirSync(testDir, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith('.zip'))) {
    await archive.loadArchive(path.join(testDir, file.name), false);
  }
  const names = Object.keys(archive.sources[0]!.data);

  for (let i = 0; i < 100; i++) {
    // Verify 100 random files
    const randIdx = Math.floor(Math.random() * names.length);
    const name = names[randIdx] as string;
    const file = archive.sources[0]!.data[name];
    const stream = await archive.readFile(name);
    if (stream !== null && file !== undefined) {
      const hash = await new Promise<number>((resolve, reject) => {
        const chunks: Buffer[] = [];
        
        stream.on('data', (chunk) => {
          if (typeof chunk === 'string') {
            chunks.push(Buffer.from(chunk));
          } else {
            chunks.push(chunk);
          }
        });
        
        stream.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (buffer.length !== file.length) {
            throw new Error('Did not read whole length');
          }
          const hash = crc32(buffer);
          resolve(hash >>> 0); // Convert to unsigned 32-bit
        });
        
        stream.on('error', reject); 
      });
      if (hash !== file.crc32) {
        throw new Error(`Bad hash: Expected ${file.crc32.toString(16).toUpperCase()}, Got ${hash.toString(16).toUpperCase()}`);
      }
    } else {
      throw new Error('File missing?');
    }
  }
}

async function run() {
  await benchmarkZipRead();
}

run();

