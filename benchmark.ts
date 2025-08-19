import { FpArchiveDataManager } from './src/MultiZipReader';
import { crc32 } from 'zlib';

const testDir = "G:\\Data\\Flashpoint\\Data\\ArchiveData";

async function benchmarkZipRead(): Promise<void> {
  const archive = new FpArchiveDataManager();
  const start = performance.now();

  await archive.loadArchive("G:\\Data\\Flashpoint\\Data\\ArchiveData\\Images.zip");
  const end = performance.now();
  const timeMs = end - start;

  // Calculate average index time
  let indexTotal = 0;
  for (const source of archive.sources) {
    indexTotal += Object.keys(source.data).length;
  }
  const filesPerSecond = indexTotal / (timeMs / 1000);
  console.log(`Indexed ${indexTotal.toLocaleString()} Files in ${timeMs.toFixed(0)}ms (${Math.floor(filesPerSecond).toLocaleString()} Files/sec)`)
}

async function testZipRead(): Promise<void> {
  const archive = new FpArchiveDataManager();
  await archive.loadDirectory(testDir);
  const names = Object.keys(archive.sources[0]!.data);

  for (let i = 0; i < 100; i++) {
    // Verify 100 random files
    const randIdx = Math.floor(Math.random() * names.length);
    const name = names[randIdx] as string;
    const file = archive.sources[0]!.data[name];
    const stream = await archive.readFileStream(name);
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

  console.log('Read data matched successfully');
}

async function run() {
  await benchmarkZipRead();
  await testZipRead();
}

run();

