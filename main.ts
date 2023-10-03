/**
MIT License

Copyright (c) 2023 Bernd Amend

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
 */
const O_RDWR = 0x2;
const O_NOCTTY = 0x100;
const O_SYNC = 0x101000;
const TCSANOW = 0;

const CSIZE = 0o000060;
const CS5 = 0o000000;
const CS6 = 0o000020;
const CS7 = 0o000040;
const CS8 = 0o000060;
const CSTOPB = 0o000100;
const CREAD = 0o000200;
const PARENB = 0o000400;
const PARODD = 0o001000;
const HUPCL = 0o002000;
const CLOCAL = 0o004000;
const CRTSCTS = 0o20000000000;
const VTIME = 5;
const VMIN = 6;

export const enum Baudrate {
  B9600 = 0o000015,
  B19200 = 0o000016,
  B38400 = 0o000017,
  B57600 = 0o010001,
  B115200 = 0o010002,
  B230400 = 0o010003,
  B460800 = 0o010004,
  B500000 = 0o010005,
  B576000 = 0o010006,
  B921600 = 0o010007,
  B1000000 = 0o010010,
  B1152000 = 0o010011,
  B1500000 = 0o010012,
  B2000000 = 0o010013,
  B2500000 = 0o010014,
  B3000000 = 0o010015,
  B3500000 = 0o010016,
  B4000000 = 0o010017,
}

export interface SerialOptions {
  baudrate: Baudrate;
  timeout_in_deciseconds: number;
  minimum_number_of_chars_read: number;
  buffer_size?: number;
}

const library = Deno.dlopen(
  "/lib/libc.so.6",
  {
    open: {
      parameters: ["pointer", "i32"],
      result: "i32",
      nonblocking: true,
    },
    close: {
      parameters: ["i32"],
      result: "i32",
      nonblocking: true,
    },
    write: {
      parameters: ["i32", "pointer", "usize"],
      result: "isize",
      nonblocking: true,
    },
    read: {
      parameters: ["i32", "pointer", "usize"],
      result: "isize",
      nonblocking: true,
    },
    __errno_location: {
      parameters: [],
      result: "pointer",
      nonblocking: true,
    },
    strerror: {
      parameters: ["i32"],
      result: "pointer",
      nonblocking: true,
    },
    tcgetattr: {
      parameters: ["i32", "pointer"],
      result: "i32",
      nonblocking: true,
    },
    tcsetattr: {
      parameters: ["i32", "i32", "pointer"],
      result: "i32",
      nonblocking: true,
    },
    cfsetspeed: {
      parameters: ["pointer", "u32"],
      result: "i32",
      nonblocking: true,
    },
  } as const,
);

async function errno() {
  const ret = await library.symbols.__errno_location();
  if (ret === null) {
    return 0;
  }
  const ptrView = new Deno.UnsafePointerView(ret);
  return ptrView.getInt32();
}

async function strerror(errnum: number) {
  const ret = await library.symbols.strerror(errnum);
  if (ret === null) {
    return "";
  }
  const ptrView = new Deno.UnsafePointerView(ret);
  return ptrView.getCString();
}

async function geterrnoString() {
  return strerror(await errno());
}

export class SerialPort implements AsyncDisposable {
  constructor(private fd: number, private options: SerialOptions) {}

  async [Symbol.asyncDispose]() {
    await this.close();
  }

  async read() {
    const ibuffer = new Uint8Array(this.options.buffer_size ?? 255);
    const rlen = await library.symbols.read(
      this.fd,
      Deno.UnsafePointer.of(ibuffer),
      ibuffer.length,
    );
    if (rlen < 0) {
      throw new Error(`Error while reading: ${await geterrnoString()}`);
    }
    return ibuffer.subarray(0, rlen as number);
  }

  async read_string() {
    return new TextDecoder().decode(await this.read());
  }

  async *read_line() {
    let data = "";
    while (true) {
      const read = await this.read_string();
      if (read.length == 0) {
        continue;
      }
      data += read;
      const lines = data.split("\n");
      data = lines.pop() as string;
      for (const l of lines) {
        yield l;
      }
    }
  }

  async write(data: Uint8Array) {
    const wlen = await library.symbols.write(
      this.fd,
      Deno.UnsafePointer.of(data),
      data.length,
    );
    if (wlen < 0) {
      throw new Error(`Error while writing: ${await geterrnoString()}`);
    }
    if (wlen !== data.length) { // could this happen!?
      throw new Error("Couldn't write data");
    }
  }

  async write_string(str: string) {
    const data = new TextEncoder().encode(str);
    return await this.write(data);
  }

  async close() {
    const ret = await library.symbols.close(this.fd);
    if (ret < 0) {
      throw new Error(`Error while closing: ${await geterrnoString()}`);
    }
  }
}

function is_platform_little_endian(): boolean {
  const buffer = new ArrayBuffer(2);
  new DataView(buffer).setInt16(0, 256, true);
  return new Int16Array(buffer)[0] === 256;
}

export async function open(file: string, options: SerialOptions) {
  const buffer = new TextEncoder().encode(file);
  const fd = await library.symbols.open(
    Deno.UnsafePointer.of(buffer),
    O_RDWR | O_NOCTTY | O_SYNC,
  );

  if (fd < 0) {
    throw new Error(`Couldn't open '${file}': ${await geterrnoString()}`);
  }

  // termios tty{};
  const tty = new ArrayBuffer(100);
  const ttyPtr = Deno.UnsafePointer.of(tty);

  if (await library.symbols.tcgetattr(fd, ttyPtr) != 0) {
    throw new Error(`tcgetattr: ${await geterrnoString()}`);
  }

  await library.symbols.cfsetspeed(ttyPtr, options.baudrate);

  const dataView = new DataView(tty);
  const littleEndian = is_platform_little_endian();
  dataView.setUint32(0, 0, littleEndian); // c_iflag
  dataView.setUint32(4, 0, littleEndian); // c_oflag

  let cflag = dataView.getUint32(8, littleEndian);
  cflag &= ~PARENB; // Clear parity bit, disabling parity (most common)
  cflag &= ~CSTOPB; // Clear stop field, only one stop bit used in communication (most common)
  cflag &= ~CSIZE; // Clear all bits that set the data size
  cflag |= CS8; // 8 bits per byte (most common)
  cflag &= ~CRTSCTS; // Disable RTS/CTS hardware flow control (most common)
  cflag |= CREAD | CLOCAL; // Turn on READ & ignore ctrl lines (CLOCAL = 1)
  dataView.setUint32(8, cflag, littleEndian); // c_cflag

  dataView.setUint32(12, 0, littleEndian); // c_lflag

  // Wait for up to 1s (10 deciseconds), returning as soon as any data is received.
  dataView.setUint8(17 + VTIME, options.timeout_in_deciseconds);
  dataView.setUint8(17 + VMIN, options.minimum_number_of_chars_read);

  if (await library.symbols.tcsetattr(fd, TCSANOW, ttyPtr) != 0) {
    throw new Error(`tcsetattr: ${await geterrnoString()}`);
  }

  return new SerialPort(fd, options);
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sendStuff(serial_port: SerialPort) {
  while (true) {
    await serial_port.write_string("Test message\n");
    await sleep(2000);
  }
}

async function print(serial_port: SerialPort) {
  for await (const l of serial_port.read_line()) {
    console.log(`Data: ${l}`);
  }
}

// Learn more at https://deno.land/manual/examples/module_metadata#concepts
if (import.meta.main) {
  const serial_port = await open("/dev/ttyUSB0", {
    baudrate: Baudrate.B115200,
    minimum_number_of_chars_read: 0,
    timeout_in_deciseconds: 10,
  });

  await Promise.race([sendStuff(serial_port), print(serial_port)]);
  // while (true) {
  //   const read = await serial_port.readString();
  //   console.log(`Data: ${read}`);
  //   if (read.length == 0) {
  //     await serial_port.writeUTF8("Hallo");
  //   }
  // }

  //serial_port.close();
}
