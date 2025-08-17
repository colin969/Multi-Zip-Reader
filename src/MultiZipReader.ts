import * as fs from 'node:fs';
import { ReadStream } from 'node:fs';

interface ArchiveDataManager {
  data: Record<string, ArchiveDataFile>;
  loadArchive(filePath: string): Promise<ArchiveDataSource>;
  readFile(filePath: string): Promise<ArchiveDataStreamable | null>;
}

type ArchiveDataStreamable = ReadStream & ArchiveDataFile;

type ArchiveDataSource = {
  path: string;
  size: number;
}

type ArchiveDataFile = {
  source: ArchiveDataSource;
  offset: number;
  length: number;
}

export class FpArchiveDataManager implements ArchiveDataManager {
  data: Record<string, ArchiveDataFile> = {};

  async loadArchive(filePath: string, cache = true): Promise<ArchiveDataSource> {

    console.log(`Testing ${filePath}`);
    const startTime = Date.now();
    // Read archive contents
    const fd = await fs.promises.open(filePath, 'r');
    const stats = await fd.stat();
    const fileSize = stats.size;

    const archive: ArchiveDataSource = {
      path: filePath,
      size: fileSize
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
    const centralDirSize = eocdBuffer.readUInt32LE(12); // Size of central directory in bytes
    const totalEntries = eocdBuffer.readUInt16LE(10); // Number of central directory records

    console.log(`Zip EOCD - Offset: 0x${eocdPos.toString(16)}`);
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

      console.log(`Zip 64 EOCD - Offset: 0x${eocd64Pos}`);

      const eocd64Buffer = Buffer.alloc(56);
      await fd.read(eocd64Buffer, 0, 56, eocd64Pos);

      const total64Entries = eocd64Buffer.readBigUint64LE(32);
      const centralDir64Size = eocd64Buffer.readBigUint64LE(40);
      const centralDir64Offset = eocd64Buffer.readBigUint64LE(48);

      const chunkSize = 64 * 1024; // 64kb chunks
      let remainingBuffer = Buffer.alloc(0); // Buffer to hold partial records from previous chunk
      let processedBytes = 0n;
      let entries = 0;

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
          if (cdBuffer.readUint32LE(pos) !== 0x02014b50) {
            // console.error(`Bad signature at pos ${pos}: ${cdBuffer.readUint32LE(pos).toString(16)}`);
            console.log(`pos: ${pos}`);
            throw new Error(':(');
          }
          
          const nameLength = cdBuffer.readUInt16LE(pos + 28);
          const extraFieldLength = cdBuffer.readUInt16LE(pos + 30);
          const fileCommentLength = cdBuffer.readUInt16LE(pos + 32);
          
          recordSize = 46 + nameLength + extraFieldLength + fileCommentLength;
          
          // Check if we have the complete record in the buffer
          if (pos + recordSize > cdBuffer.length) {
            break;
          }

          let uncompressedLength: number = cdBuffer.readUint32LE(pos + 20);
          let length: number = cdBuffer.readUint32LE(pos + 24);
          let offset: number = cdBuffer.readUInt32LE(pos + 42);
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
          if (offset === 0xffffffff) {
            offset = Number(cdBuffer.readBigUInt64LE(pos + 46 + nameLength + zip64Pos));
            zip64Pos += 8;
          }
          
          
          if (cdBuffer.readUInt16LE(pos + 10) === 0) {
            // 'Store' compression, process file
            const crc32 = cdBuffer.readUint32LE(pos + 16);
            const fileName = cdBuffer.toString('utf8', pos + 46, pos + 46 + nameLength);
            // console.log(fileName);
            this.data[fileName] = {
              source: archive,
              length: length,
              offset: offset,
            }
            entries += 1;
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

      console.log(`Central Directory (64) - Offset: 0x${centralDir64Offset.toString(16)} - Size: ${centralDir64Size} - Entries Processed - ${entries} of ${totalEntries}`);
    } else {
      const cdBuffer = Buffer.alloc(centralDirSize);
      await fd.read(cdBuffer, 0, centralDirSize, centralDirOffset);

      let pos = 0;
      let entry = 0;
      while (pos + 46 <= cdBuffer.length) {
        if (cdBuffer.readUint32LE(pos) !== 0x02014b50) {
          // console.error(pos);
          // console.error(`Bad signature: ${cdBuffer.readUint32LE(pos).toString(16)}`);
        }

        const nameLength = cdBuffer.readUInt16LE(pos + 28);
        const extraFieldLength = cdBuffer.readUInt16LE(pos + 30);
        const fileCommentLength = cdBuffer.readUInt16LE(pos + 32);

        if (cdBuffer.readUInt16LE(pos + 10) === 0) {
          // 'Store' compression, process file

          const crc32 = cdBuffer.readUint32LE(pos + 16);
          const length = cdBuffer.readUint32LE(pos + 24);
          const offset = cdBuffer.readUInt32LE(pos + 42);
          const fileName = cdBuffer.toString('utf8', pos + 46, pos + 46 + nameLength);
          console.log(fileName);
        }

        pos += 46 + nameLength + extraFieldLength + fileCommentLength;
      }

      console.log(`Central Directory - Offset: 0x${centralDirOffset.toString(16)} - Size: ${centralDirSize} - Entries - ${totalEntries}`);
    }

    await fd.close();


    const endTime = Date.now();
    console.log(`Time taken to index ${totalEntries} files - ${endTime - startTime}ms`);

    return archive;
  }

  async readFile(filePath: string): Promise<ArchiveDataStreamable | null> {
    const fileInfo = this.data[filePath];
    if (fileInfo !== undefined) {
      if (fileInfo.length === 0) {
        // Return an empty stream instead?
        return {
          source: fileInfo.source,
          offset: fileInfo.offset,
          length: fileInfo.length
        } as any;
      }
      const stream = fs.createReadStream(fileInfo.source.path, {
        start: Number(fileInfo.offset),
        end: Number(fileInfo.offset + fileInfo.length) - 1
      }) as ArchiveDataStreamable;

      stream.source = fileInfo.source;
      stream.offset = fileInfo.offset;
      stream.length = fileInfo.length;

      return stream;
    }
    return null;
  }
}

// End of Central Directory record - Regular Zip
//
// Bytes | Description
// ------+-------------------------------------------------------------------
//     4 | Signature (0x06054b50)
//     2 | Number of this disk (0xFF if Zip64 archive)
//     2 | Disk where central directory starts
//     2 | Numbers of central directory records on this disk
//     2 | Total number of central directory records
//     4 | Size of central directory in bytes
//     4 | Offset to start of central directory
//     2 | Comment length (n)
//     n | Comment

// End of Central Directory record Zip 64 - 56 bytes not including Comment
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

// Central Directory file record - 46 bytes not including metadata
// Bytes | Description
// ------+-------------------------------------------------------------------
//     4 | Signature (0x02014b50)
//     2 | Version made by
//     2 | Minimum version needed to extract
//     2 | Bit flag
//     2 | Compression method
//     2 | File last modification time (MS-DOS format)
//     2 | File last modification date (MS-DOS format)
//     4 | CRC-32 of uncompressed data
//     4 | Compressed size
//     4 | Uncompressed size
//     2 | File name length (n)
//     2 | Extra field length (m)
//     2 | File comment length (k)
//     2 | Disk number where file starts
//     2 | Internal file attributes
//     4 | External file attributes
//     4 | Offset of local file header (from start of disk)
//     n | File name
//     m | Extra field
//     k | File comment
