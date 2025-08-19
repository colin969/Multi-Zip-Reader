import * as fs from 'node:fs';
import { ReadStream } from 'node:fs';
import * as path from 'node:path';
import v8 from 'node:v8';
import { crc32, createInflate, createInflateRaw } from 'node:zlib';

const CUR_VERSION = 0;

interface ArchiveDataManager {
  sources: ArchiveDataSource[];
  loadArchive(filePath: string): Promise<ArchiveDataSource>;
  readFile(filePath: string): Promise<Buffer | null>;
  readFileStream(filePath: string): Promise<ReadStream | null>;
}

type ArchiveDataSource = {
  mzrVersion: number;
  path: string;
  size: number;
  data: Record<string, ArchiveDataFile>;
}

type ArchiveDataFile = {
  crc32: number;
  fileHeaderOffset: number;
  length: number;
}

type ZipDataOffset = {
  filePath: string;
  crc32: number;
  offset: number;
  compressionMethod: number; // 0 = Store, 8 = Deflate
  compressedLength: number;
  length: number;
}

export class FpArchiveDataManager implements ArchiveDataManager {
  sources: ArchiveDataSource[] = [];

  async loadDirectory(dirPath: string, cache = false): Promise<void> {
    for (const file of fs.readdirSync(dirPath, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith('.zip'))) {
      await this.loadArchive(path.join(dirPath, file.name), false);
    }
  }

  async loadArchive(filePath: string, cache = false): Promise<ArchiveDataSource> {
    const archiveData: Record<string, ArchiveDataFile> = {};

    for (const source of this.sources) {
      if (source.path === filePath) {
        throw new Error('Archive already loaded');
      }
    }

    const fileExt = path.extname(filePath);
    const indexFilePath = filePath.substring(0, filePath.length - fileExt.length) + '.mzrindex';

    // Read archive metadata
    const fd = await fs.promises.open(filePath, 'r');
    const stats = await fd.stat();
    const fileSize = stats.size;

    if (cache) {
      try {
        // Try and load cache
        const buffer = await fs.promises.readFile(indexFilePath);
        const cachedArchive = v8.deserialize(buffer);
        if (cachedArchive.size === fileSize && cachedArchive.mzrVersion === CUR_VERSION) {
          this.sources.push(cachedArchive);
          await fd.close();
          return cachedArchive;
        }
      } catch {
        // Could not read cache, just carry on
      }
    }

    const archive: ArchiveDataSource = {
      mzrVersion: CUR_VERSION,
      path: filePath,
      size: fileSize,
      data: archiveData,
    };

    // Read the central directory at the end of the file
    const bufferSize = 1024;
    const buffer = Buffer.alloc(bufferSize);
    const readSize = Math.min(bufferSize, fileSize);

    await fd.read(buffer, 0, readSize, fileSize - readSize);

    // Find end of central directory record

    let eocdPos = -1;
    for (let i = buffer.length - 4; i >= 0; i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) {
        eocdPos = fileSize - readSize + i;
        break;
      }
    }

    if (eocdPos === -1) {
      throw new Error('Invalid ZIP file: End of central directory not found');
    }

    const eocdBuffer = Buffer.alloc(22);
    await fd.read(eocdBuffer, 0, 22, eocdPos);

    const centralDirOffset = eocdBuffer.readUInt32LE(16); // Offset to start of central directory
    const isZip64 = centralDirOffset === 0xffffffff;
    const entryCount = eocdBuffer.readUInt16LE(10); // Number of records
    const centralDirSize = eocdBuffer.readUInt32LE(12); // Size of central directory in bytes

    if (isZip64) {
      let eocd64Pos = -1;
      for (let i = buffer.length - 4; i >= 0; i--) {
        if (buffer.readUInt32LE(i) === 0x06064b50) {
          eocd64Pos = fileSize - readSize + i;
          break;
        }
      }

      if (eocd64Pos === -1) {
        throw new Error('Invalid ZIP64 file: End of central directory not found');
      }


      const eocd64Buffer = Buffer.alloc(56);
      await fd.read(eocd64Buffer, 0, 56, eocd64Pos);

      const centralDir64Size = eocd64Buffer.readBigUint64LE(40);
      const centralDir64Offset = eocd64Buffer.readBigUint64LE(48);

      const chunkSize = 64 * 1024; // 64kb chunks
      let remainingBuffer = Buffer.alloc(0); // Buffer to hold partial records from previous chunk
      let processedBytes = 0n;

      while (processedBytes < centralDir64Size) {
        // Read next chunk of central directory
        const bytesLeft = (centralDir64Size - processedBytes);
        const readSize = bytesLeft > BigInt(chunkSize) ? chunkSize : Number(bytesLeft);
        const newChunk = Buffer.alloc(readSize);
        
        await fd.read(newChunk, 0, readSize, (centralDir64Offset + processedBytes) as any);
        processedBytes += BigInt(readSize);
        
        // Combine remaining buffer from previous chunk with new chunk
        const cdBuffer = Buffer.concat([remainingBuffer, newChunk]);
        let pos = 0;
        let recordSize = 0;
        
        while (pos + 46 <= cdBuffer.length) {
          // Check for valid central directory signature
          if (cdBuffer.readUInt32LE(pos) !== 0x02014b50) {
            throw new Error(`Bad file header signature for ${filePath} got 0x${cdBuffer.readUInt32LE(pos).toString(16)}`);
          }
          
          const crc32 = cdBuffer.readUInt32LE(pos + 16);
          const nameLength = cdBuffer.readUInt16LE(pos + 28);
          const extraFieldLength = cdBuffer.readUInt16LE(pos + 30);
          const fileCommentLength = cdBuffer.readUInt16LE(pos + 32);
          const externAttributes = cdBuffer.readUInt16LE(pos + 38);
        
          if ((externAttributes & 0x10) || ((externAttributes >> 16) & 0o040000)) {
            // Is directory, skip
            recordSize = 46 + nameLength + extraFieldLength + fileCommentLength;
            pos += recordSize;
            continue;
          }
          
          recordSize = 46 + nameLength + extraFieldLength + fileCommentLength;
          
          // Check if we have the complete record in the buffer
          if (pos + recordSize > cdBuffer.length) {
            break;
          }

          let uncompressedLength: number = cdBuffer.readUint32LE(pos + 20);
          let length: number = cdBuffer.readUint32LE(pos + 24);
          let fileHeaderOffset: number = cdBuffer.readUInt32LE(pos + 42);
          // Read Zip64 extra field
          let zip64Pos = 4;
          if (uncompressedLength === 0xffffffff) {
            uncompressedLength = Number(cdBuffer.readBigUInt64LE(pos + 46 + nameLength + zip64Pos));
            zip64Pos += 8;
          }
          if (length === 0xffffffff) {
            length = Number(cdBuffer.readBigUInt64LE(pos + 46 + nameLength + zip64Pos));
            zip64Pos += 8;
          }
          if (fileHeaderOffset === 0xffffffff) {
            fileHeaderOffset = Number(cdBuffer.readBigUInt64LE(pos + 46 + nameLength + zip64Pos));
            zip64Pos += 8;
          }

          const fileName = cdBuffer.toString('utf8', pos + 46, pos + 46 + nameLength);
          archiveData[fileName] = {
            crc32,
            length,
            fileHeaderOffset,
          }
          
          pos += recordSize;
        }
        
        // If we processed all records in this buffer, clear the remaining buffer
        if (pos + 46 > cdBuffer.length || pos + recordSize > cdBuffer.length) {
          remainingBuffer = cdBuffer.subarray(pos);
        } else {
          remainingBuffer = Buffer.alloc(0);
        }
      }      

    } else {
      const cdBuffer = Buffer.alloc(centralDirSize);
      await fd.read(cdBuffer, 0, centralDirSize, centralDirOffset);

      let pos = 0;
      while (pos + 46 <= cdBuffer.length) {
        if (cdBuffer.readUint32LE(pos) !== 0x02014b50) {
          throw new Error('Bad file header signature');
        }

        const nameLength = cdBuffer.readUInt16LE(pos + 28);
        const extraFieldLength = cdBuffer.readUInt16LE(pos + 30);
        const fileCommentLength = cdBuffer.readUInt16LE(pos + 32);
        const externAttributes = cdBuffer.readUInt16LE(pos + 38);
        
        if ((externAttributes & 0x10) || ((externAttributes >> 16) & 0o040000)) {
          // Is directory, skip
          pos += 46 + nameLength + extraFieldLength + fileCommentLength;
          continue;
        }

        const crc32 = cdBuffer.readUInt32LE(pos + 16);
        const length = cdBuffer.readUint32LE(pos + 24);
        const fileHeaderOffset = cdBuffer.readUInt32LE(pos + 42);
        const fileName = cdBuffer.toString('utf8', pos + 46, pos + 46 + nameLength);
        archiveData[fileName] = {
          crc32,
          length,
          fileHeaderOffset,
        }

        pos += 46 + nameLength + extraFieldLength + fileCommentLength;
      }

    }

    await fd.close();

    this.sources.push(archive);
    if (cache) {
      await this.writeCache(indexFilePath, archive);
    }

    return archive;
  }

  async writeCache(cacheFilePath: string, source: ArchiveDataSource) {
    const buffer = v8.serialize(source);
    await fs.promises.writeFile(cacheFilePath, buffer);
  }

  async _createStreamFromOffset(zipDataOffset: ZipDataOffset): Promise<ReadStream | null> {
    if (zipDataOffset.length === 0) {
      return null;
    }

    const stream = fs.createReadStream(zipDataOffset.filePath, {
      start: zipDataOffset.offset,
      end: Number(zipDataOffset.offset + zipDataOffset.compressedLength) - 1
    });

    // Pipe deflated data through inflate stream
    if (zipDataOffset.compressionMethod === 8) {
      const inflateStream = createInflateRaw();
      stream.pipe(inflateStream);
      return inflateStream as unknown as ReadStream;
    }

    // Store, pipe back raw data
    return stream;
  }

  async readFile(filePath: string): Promise<Buffer | null> {
    const zipDataOffset = await this.getZipDataOffset(filePath);
    if (zipDataOffset === null) {
      throw createENOENTError(filePath);
    }

    const stream = await this._createStreamFromOffset(zipDataOffset);
    if (stream === null) {
      return null;
    }

    return new Promise<Buffer>((resolve, reject) => {
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
        if (buffer.length !== zipDataOffset.length) {
          throw new Error('Did not read whole length');
        }
        const hash = crc32(buffer);
        if (hash !== zipDataOffset.crc32) {
          throw new Error('CRC32 did not match file data');
        }
        resolve(buffer); // Convert to unsigned 32-bit
      });
      
      stream.on('error', reject); 
    });
  }

  async readFileStream(filePath: string): Promise<ReadStream | null> {
    const zipDataOffset = await this.getZipDataOffset(filePath);
    if (zipDataOffset === null) {
      throw createENOENTError(filePath);
    }
    
    return this._createStreamFromOffset(zipDataOffset);
  }

  async getZipDataOffset(filePath: string): Promise<ZipDataOffset | null> {
    let fileInfo: ArchiveDataFile | undefined = undefined;
    let source: ArchiveDataSource | undefined = undefined;
    for (const s of this.sources) {
      fileInfo = s.data[filePath];
      if (fileInfo !== undefined) {
        source = s;
        break;
      } 
    }
    if (fileInfo === undefined || source === undefined) {
      return null;
    }
    if (fileInfo !== undefined) {
      if (fileInfo.length === 0) {
        return {
          filePath: source.path,
          crc32: fileInfo.crc32,
          offset: 0,
          compressionMethod: 0,
          compressedLength: 0,
          length: 0
        }
      }

      // Read local file header
      const fd = await fs.promises.open(source.path, 'r');
      const lfhBuffer = Buffer.alloc(30);
      await fd.read(lfhBuffer, 0, 30, fileInfo.fileHeaderOffset);

      const compressionMethod = lfhBuffer.readUint16LE(8);
      let compressedLength = lfhBuffer.readUInt32LE(18);
      let length = lfhBuffer.readUInt32LE(22);
      const nameLength = lfhBuffer.readUint16LE(26);
      const extraFieldLength = lfhBuffer.readUInt16LE(28);

      if (length === 0xFFFFFFFF || compressedLength === 0xFFFFFFFF) {
        let zip64Pos = 4;
        const zip64Buffer = Buffer.alloc(extraFieldLength);
        await fd.read(zip64Buffer, 0, extraFieldLength, fileInfo.fileHeaderOffset + 30 + nameLength);

        if (length === 0xFFFFFFFF) {
          length = Number(zip64Buffer.readBigUInt64LE(zip64Pos));
          zip64Pos += 8;
        }

        if (compressedLength === 0xFFFFFFFF) {
          compressedLength = Number(zip64Buffer.readBigUInt64LE(zip64Pos));
          zip64Pos += 8;
        }
      }
      console.log(`Method: ${compressionMethod} - Comp Length: ${compressedLength} - Length: ${length}`);

      const trueOffset = fileInfo.fileHeaderOffset + 30 + nameLength + extraFieldLength;
      await fd.close();

      // Just read the field sizes so we can get the accurate start point

      return {
        filePath: source.path,
        crc32: fileInfo.crc32,
        compressionMethod,
        compressedLength,
        length,
        offset: trueOffset,
      }
    }
    return null;
  }
}

function createENOENTError(path: string) {
  const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  error.errno = -2; // Standard errno for ENOENT
  error.syscall = 'open';
  error.path = path;
  return error;
}

// == Local File Header ==
// Offset Length Field
// 0	4	Magic number. Must be 50 4B 03 04 (PK♥♦ in latin1).
// 4	2	Version needed to extract (minimum).
// 6	2	General purpose bit flag.
// 8	2	Compression method; e.g. none = 0, DEFLATE = 8 (or "\0x08\0x00").
// 10	2	File last modification time.
// 12	2	File last modification date.
// 14	4	CRC-32 of uncompressed data.
// 18	4	Compressed size (or FF FF FF FF for ZIP64).
// 22	4	Uncompressed size (or FF FF FF FF for ZIP64).
// 26	2	File name length (n).
// 28	2	Extra field length (m).
// 30	n	File name.
// 30+n	m	Extra field.

// == End of Central Directory record - Regular Zip ==
// Offset Length Field
// 0	4	Magic number. Must be 50 4B 05 06.
// 4	2	Number of this disk (or FF FF for ZIP64).
// 6	2	Disk where central directory starts (or FF FF for ZIP64).
// 8	2	Number of central directory records on this disk (or FF FF for ZIP64).
// 10	2	Total number of central directory records (or FF FF for ZIP64).
// 12	4	Size of central directory in bytes (or FF FF FF FF for ZIP64).
// 16	4	Offset of start of central directory, relative to start of archive (or FF FF FF FF for ZIP64).
// 20	2	Comment length (n).
// 22	n	Comment.

// == End of Central Directory record Zip 64 - 56 bytes not including Comment ==
// Offset Length Field
// 0	4	Magic number. Must be 50 4B 06 06.
// 4	8	Size of the EOCD64 minus 12.
// 12	2	Version made by.
// 14	2	Version needed to extract (minimum).
// 16	4	Number of this disk.
// 20	4	Disk where central directory starts.
// 24	8	Number of central directory records on this disk.
// 32	8	Total number of central directory records.
// 40	8	Size of central directory in bytes.
// 48	8	Offset of start of central directory, relative to start of archive.
// 56	n	Comment (up to the size of EOCD64).

// == Central Directory file record - 46 bytes not including metadata ==
// Offset Length Field
// 0	4	Magic number. Must be 50 4B 01 02.
// 4	2	Version made by.
// 6	2	Version needed to extract (minimum).
// 8	2	General purpose bit flag.
// 10	2	Compression method.
// 12	2	File last modification time.
// 14	2	File last modification date.
// 16	4	CRC-32 of uncompressed data.
// 20	4	Compressed size (or FF FF FF FF for ZIP64).
// 24	4	Uncompressed size (or FF FF FF FF for ZIP64).
// 28	2	File name length (n).
// 30	2	Extra field length (m).
// 32	2	File comment length (k).
// 34	2	Disk number where file starts (or FF FF for ZIP64).
// 36	2	Internal file attributes.
// 38	4	External file attributes.
// 42	4	Relative offset of local file header (or FF FF FF FF for ZIP64). This is the number of bytes between the start of the first disk on which the file occurs, and the start of the local file header. This allows software reading the central directory to locate the position of the file inside the ZIP file.
// 46	n	File name.
// 46+n	m	Extra field.
// 46+n+m	k	File comment.