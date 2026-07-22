import { DEFAULT_CHUNK_SIZE } from '~constants';

export class ArrayUtils {
  static chunkify<T>(data: T[], chunkSize = DEFAULT_CHUNK_SIZE): T[][] {
    const batches = Math.ceil(data.length / chunkSize);

    return Array(batches)
      .fill(null)
      .map((chunk, idx) => {
        const offset = idx * chunkSize;

        return data.slice(offset, offset + chunkSize);
      });
  }
}
