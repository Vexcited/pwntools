import type { Socket } from "bun";

export class Tube {
  private buffer = new Uint8Array(0);
  private waiters: Array<() => void> = [];
  private closed = false;
  private offset = 0;

  protected rclose(): void {
    this.closed = true;
    this.notify();
  }

  protected rwrite(chunk: Buffer<ArrayBufferLike>): void {
    const merged = new Uint8Array(
      this.buffer.length - this.offset + chunk.length
    );
    merged.set(this.buffer.subarray(this.offset));
    merged.set(chunk, this.buffer.length - this.offset);

    this.buffer = merged;
    this.offset = 0;

    this.notify();
  }

  private notify(): void {
    this.waiters.forEach((resolve) => resolve());
    this.waiters = [];
  }

  private async waitFor(n: number): Promise<void> {
    while (this.buffer.length - this.offset < n) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /**
   * Read exactly `n` bytes.
   */
  public async recvn(n: number): Promise<Uint8Array> {
    await this.waitFor(n);
    const out = this.buffer.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  /**
   * Read until newline (LF)
   */
  public async recvline(): Promise<Uint8Array> {
    while (true) {
      const i = this.buffer.indexOf(0x0a, this.offset); // \n

      if (i !== -1) {
        const out = this.buffer.subarray(this.offset, i + 1);
        this.offset = i + 1;
        return out;
      }

      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /**
   * Read until a specific delimiter is found
   */
  public async recvuntil(delimiter: Uint8Array): Promise<Uint8Array> {
    while (true) {
      for (
        let i = this.offset;
        i <= this.buffer.length - delimiter.length;
        i++
      ) {
        let match = true;
        for (let j = 0; j < delimiter.length; j++) {
          if (this.buffer[i + j] !== delimiter[j]) {
            match = false;
            break;
          }
        }

        if (match) {
          const out = this.buffer.subarray(this.offset, i + delimiter.length);
          this.offset = i + delimiter.length;
          return out;
        }
      }

      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /**
   * Receives data until EOF is reached and closes the tube.
   */
  public async recvall(): Promise<Uint8Array> {
    while (!this.closed) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    const out = this.buffer.subarray(this.offset);
    this.offset = this.buffer.length;
    return out;
  }
}

export class Sock extends Tube {
  public constructor(private readonly socket: Socket<BunSocketData>) {
    super();

    this.socket.data = {
      write: (chunk) => this.rwrite(chunk),
      close: () => this.rclose(),
    };
  }

  public write(d: Uint8Array) {
    this.socket.write(d);
  }

  public close(): void {
    this.socket.close();
  }
}

type BunSocketData = {
  write: (data: Buffer<ArrayBufferLike>) => void;
  close: () => void;
};

export const remote = async (
  lhost: string,
  lport: number,
  options = {
    tls: false,
  }
) => {
  const socket = await Bun.connect<BunSocketData>({
    tls: options.tls,
    hostname: lhost,
    port: lport,

    socket: {
      data(socket, data) {
        socket.data.write(data);
      },
      close(socket) {
        socket.data.close();
      },
    },
  });

  return new Sock(socket);
};
