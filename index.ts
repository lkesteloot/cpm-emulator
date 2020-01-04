import program from "commander";
import * as fs from "fs";
import * as path from "path";
import readline from "readline";
import {Writable} from "stream";
import {toHex} from "z80-base";
import {Disasm, Instruction} from "z80-disasm";
import {Hal, Z80} from "z80-emulator";
import NullWritable from "null-writable";

// Compile-time configuration.
const DUMP_ASSEMBLY = false;
const WRITE_LOG = false;
const WRITE_PRINTER = false;

const LOAD_ADDRESS = 0x0100;
const CPM_CALL_ADDRESS = 0x0005;
const RECORD_SIZE = 128;
const DEFAULT_DMA = 0x0080;
const FCB1_ADDRESS = 0x005C;
const FCB2_ADDRESS = 0x006C;
// Location of BDOS + BIOS.
const BDOS_ADDRESS = 0xFE00;
const CBIOS_ADDRESS = 0xFF00;

enum CbiosEntryPoint {
    BOOT, // COLD START
    WBOOT, // WARM START
    CONST, // CONSOLE STATUS
    CONIN, // CONSOLE CHARACTER IN
    CONOUT, // CONSOLE CHARACTER OUT
    LIST, // LIST CHARACTER OUT
    PUNCH, // PUNCH CHARACTER OUT
    READER, // READER CHARACTER OUT
    HOME, // MOVE HEAD TO HOME POSITION
    SELDSK, // SELECT DISK
    SETTRK, // SET TRACK NUMBER
    SETSEC, // SET SECTOR NUMBER
    SETDMA, // SET DMA ADDRESS
    READ, // READ DISK
    WRITE, // WRITE DISK
    LISTST, // RETURN LIST STATUS
    SECTRAN, // SECTOR TRANSLATE
}
const CBIOS_ENTRY_POINT_COUNT = 17;

const FD_SIGNATURE = 0xBEEF;

/**
 * File Control Block, a 36-byte block describing an open file. This object
 * is a view into memory. Changes to the parameters write through to the
 * underlying memory.
 *
 * http://members.iinet.net.au/~daveb/cpm/fcb.html
 */
class Fcb {
    private readonly mem: Uint8Array;

    constructor(mem: Uint8Array) {
        this.mem = mem;
    }

    public dump(log: Writable, address: number): void {
        log.write(`FCB at ${toHex(address, 4)}: ${this.getFilename()}, ex=${toHex(this.mem[12], 2)}, s1=${toHex(this.mem[13], 2)}, `);
        log.write(`s2=${toHex(this.mem[14], 2)}, rc=${toHex(this.mem[15], 2)}, d=`);
        for (let i = 0; i < 16; i++) {
            log.write(toHex(this.mem[16 + i], 2));
        }
        log.write(`, cr=${toHex(this.mem[32], 2)}, r=`);
        for (let i = 0; i < 3; i++) {
            log.write(toHex(this.mem[35 - i], 2));
        }
        log.write("\n");
    }

    // Clear internal state.
    public clear(): void {
        this.s2 = 0;
        this.fd = 0;
    }

    /**
     * The drive number. This is typically 0 to mean "current drive", then
     * 1 for A:, 2 for B:, etc.
     */
    get drive(): number {
        return this.mem[0];
    }

    /**
     * The main name of the file (the part without the extension).
     */
    get name(): string {
        let name = "";

        for (let i = 1; i < 9; i++) {
            const letter = this.mem[i] & 0x7F;
            if (letter > 32) {
                name += String.fromCodePoint(letter);
            }
        }

        return name;
    }

    /**
     * The file type i.e., the extension, without the dot.
     */
    get fileType(): string {
        let fileType = "";

        for (let i = 9; i < 12; i++) {
            const letter = this.mem[i] & 0x7F;
            if (letter > 32) {
                fileType += String.fromCodePoint(letter);
            }
        }

        return fileType;
    }

    /**
     * The current extent number.
     */
    get ex(): number {
        return this.mem[0x0C];
    }

    /**
     * The current extent number.
     */
    set ex(n: number) {
        this.mem[0x0C] = n;
    }

    get s2(): number {
        return this.mem[0x0E];
    }

    set s2(n: number) {
        this.mem[0x0E] = n;
    }

    /**
     * The current record number within the current extent.
     */
    get cr(): number {
        return this.mem[0x20];
    }

    /**
     * The current record number within the current extent.
     */
    set cr(n: number) {
        this.mem[0x20] = n;
    }

    /**
     * Computed current record number, for sequential access.
     */
    get currentRecord(): number {
        if (this.cr > 127 || this.ex > 31 || this.s2 > 16 || (this.s2 === 16 && (this.cr !== 0 || this.ex !== 0))) {
            throw new Error("Invalid current record");
        }
        return this.cr | (this.ex << 7) | (this.s2 << 12);
    }

    /**
     * Computed current record, for sequential access.
     */
    set currentRecord(n: number) {
        this.cr = n & 0x7F;
        this.ex = (n >> 7) & 0x1F;
        this.s2 = n >> 12;
    }

    /**
     * Computed record number, for random access.
     */
    get randomRecord(): number {
        return this.mem[0x21] | (this.mem[0x22] << 8);
    }

    /**
     * Computed record number, for random access.
     */
    set randomRecord(n: number) {
        this.mem[0x21] = n & 0xFF;
        this.mem[0x22] = (n >> 8) & 0xFF;
        // Indicate overflow.
        this.mem[0x23] = n > 0xFFFF ? 0x01 : 0x00;
    }

    /**
     * Unix file descriptor, if the file is open, or 0 if not yet open.
     */
    get fd(): number {
        const n1 = this.mem[0x10] | (this.mem[0x11] << 8);
        const n2 = this.mem[0x12] | (this.mem[0x13] << 8);

        if ((n1 ^ FD_SIGNATURE) !== n2) {
            throw new Error("Invalid FD: " + n1 + " and " + n2);
        }

        return n1;
    }

    /**
     * Unix file descriptor, if the file is open, or 0 if not yet open.
     */
    set fd(n: number) {
        this.mem[0x10] = n & 0xFF;
        this.mem[0x11] = (n >> 8) & 0xFF;

        // Store it differently so we can tell if it's invalid on read.
        n ^= FD_SIGNATURE;
        this.mem[0x12] = n & 0xFF;
        this.mem[0x13] = (n >> 8) & 0xFF;
    }

    /**
     * Computed full filename.
     */
    public getFilename(): string {
        return this.name + "." + this.fileType;
    }

    /**
     * Set the filename and file type part of the FCB to spaces.
     */
    public static blankOut(memory: Uint8Array, address: number): void {
        // Current drive.
        memory[address] = 0;
        for (let i = 0; i < 11; i++) {
            // Spaces for "no filename".
            memory[address + i + 1] = 0x20;
        }
    }
}

/**
 * CP/M hardware abstraction layer. This provides the memory for the Z80, but
 * also intercepts calls to the CP/M BDOS and CBIOS routines.
 */
class Cpm implements Hal {
    /**
     * Flat memory array for RAM.
     */
    private memory = new Uint8Array(64*1024);
    /**
     * Log file for dumping the internal state of the emulator.
     */
    private readonly log: Writable;
    /**
     * Printer output.
     */
    private readonly printer: Writable;
    /**
     * The current drive: 0 = A, 1 = B, ...
     */
    private currentDrive = 0;
    /**
     * Function to call next time we get a keystroke. If this
     * is defined, then the emulator is blocked waiting for a key.
     */
    private keyResolve: ((key: number) => void) | undefined;
    /**
     * Queue of keys to supply next time the emulator needs one.
     * The next one to use is at the front (shift).
     */
    private keyQueue: number[] = [];
    /**
     * Map from drive number (0 = A, etc.) to host directory.
     */
    private driveDirMap = new Map<number, string>();
    /**
     * Location of the Direct Memory Access buffer. This is used by
     * BDOS to read and write records, and occasionally for other
     * large results.
     */
    private dma = DEFAULT_DMA;
    /**
     * List of sorted directory entry names when iterating through a directory.
     */
    private dirEntries: string[] = [];

    constructor(bin: Buffer, log: Writable, printer: Writable) {
        this.log = log;
        this.printer = printer;
        for (let i = 0; i < bin.length; i++) {
            this.memory[LOAD_ADDRESS + i] = bin[i];
        }

        // Warm boot.
        this.memory[0] = 0xC3; // JP
        this.memory[1] = (CBIOS_ADDRESS + 3) & 0xFF;
        this.memory[2] = ((CBIOS_ADDRESS + 3) >> 8) & 0xFF;

        // Call our BDOS at the CP/M syscall address.
        this.memory[CPM_CALL_ADDRESS] = 0xC3; // JP
        this.memory[CPM_CALL_ADDRESS + 1] = BDOS_ADDRESS & 0xFF;
        this.memory[CPM_CALL_ADDRESS + 2] = (BDOS_ADDRESS >> 8) & 0xFF;
        this.memory[BDOS_ADDRESS] = 0xC9; // RET

        // Set all CBIOS routines to just return.
        for (let i = 0; i < CBIOS_ENTRY_POINT_COUNT; i++) {
            this.memory[CBIOS_ADDRESS + i*3] = 0xC9; // RET
        }

        // Blank out command-line FCBs.
        Fcb.blankOut(this.memory, FCB1_ADDRESS);
        Fcb.blankOut(this.memory, FCB2_ADDRESS);
    }

    /**
     * Configure a drive to map to a host directory.
     *
     * @param drive 0 = A, etc.
     * @param dir host directory.
     */
    public setDrive(drive: number, dir: string): void {
        this.driveDirMap.set(drive, dir);
    }

    /**
     * Number of clock cycles emulated so far.
     */
    public tStateCount: number = 0;

    /**
     * Read a byte of memory.
     */
    public readMemory(address: number): number {
        return this.memory[address];
    }

    /**
     * Write a byte of memory.
     */
    public writeMemory(address: number, value: number): void {
        this.memory[address] = value;
    }

    /**
     * Unused.
     */
    public contendMemory(address: number): void {
    }

    /**
     * Unused.
     */
    public readPort(address: number): number {
        return 0;
    }

    /**
     * Unused.
     */
    public writePort(address: number, value: number): void {
    }

    /**
     * Unused.
     */
    public contendPort(address: number): void {
    }

    /**
     * When the guest program calls BDOS by calling 0x0005, we
     * handle the request here.
     */
    public async handleBdosCall(z80: Z80) {
        const f = z80.regs.c;

        // http://members.iinet.net.au/~daveb/cpm/bdos.html
        switch (f) {
            case 1: { // Console input.
                const value = await this.readStdin();
                z80.regs.a = value;
                z80.regs.l = value;
                process.stdout.write(String.fromCodePoint(value));
                break;
            }

            case 2: { // Console output.
                const value = z80.regs.e;
                process.stdout.write(String.fromCodePoint(value));
                break;
            }

            case 5: { // Printer output.
                this.printer.write(String.fromCodePoint(z80.regs.e));
                break;
            }

            case 6: { // Direct console I/O.
                const value = z80.regs.e;
                if (value === 0xFF) {
                    let ch = this.keyQueue.shift();
                    if (ch === undefined) {
                        ch = 0;
                    }
                    z80.regs.a = ch;
                } else {
                    process.stdout.write(String.fromCodePoint(value));
                }
                break;
            }

            case 11: { // Console status.
                const status = this.keyQueue.length === 0 ? 0 : 1;
                z80.regs.a = status;
                z80.regs.l = status;
                break;
            }

            case 13: { // Reset disk system.
                // Set the disk to read/write.
                break;
            }

            case 14: { // Select drive.
                let status;
                const value = z80.regs.e;
                if (this.driveDirMap.has(value)) {
                    this.currentDrive = value;
                    this.log.write("Selected drive " + value + "\n");
                    status = 0;
                } else {
                    // No such drive.
                    status = 0xFF;
                }
                z80.regs.a = status;
                z80.regs.l = status;
                break;
            }

            case 15: { // Open file.
                const fcb = new Fcb(this.memory.subarray(z80.regs.de));
                fcb.clear();
                this.log.write(`Opening ${fcb.getFilename()}\n`);
                fcb.dump(this.log, z80.regs.de);
                const pathname = this.makePathname(fcb);
                try {
                    fcb.fd = fs.openSync(pathname, "r+");
                    z80.regs.a = 0x00; // Success.
                } catch (err) {
                    this.log.write("Can't open " + pathname + "\n");
                    fcb.fd = 0;
                    z80.regs.a = 0xFF; // Error.
                }
                break;
            }

            case 16: { // Close file.
                const fcb = new Fcb(this.memory.subarray(z80.regs.de));
                this.log.write(`Closing ${fcb.getFilename()}\n`);
                let fd = fcb.fd;
                if (fd === 0) {
                    throw new Error("Closing unopened FCB");
                }
                fs.closeSync(fd);
                fcb.fd = 0;
                z80.regs.a = 0x00; // Success.
                break;
            }

            case 17: { // Search for first.
                const fcb = new Fcb(this.memory.subarray(z80.regs.de));
                this.log.write(`Search for first ${fcb.getFilename()}\n`);
                fcb.dump(this.log, z80.regs.de);
                const dirName = this.getDriveDir(fcb);
                const dir = fs.opendirSync(dirName);
                this.dirEntries = [];
                while (true) {
                    const entry = dir.readSync();
                    if (entry === null) {
                        break;
                    }
                    if (entry.isFile()) {
                        // TODO match wildcard in FCB.
                        this.dirEntries.push(entry.name);
                    }
                }
                dir.closeSync();
                // May as well sort.
                this.dirEntries.sort();
                this.searchForNextDirEntry(z80);
                break;
            }

            case 18: { // Search for next.
                this.log.write(`Search for next\n`);
                this.searchForNextDirEntry(z80);
                break;
            }

            case 19: { // Delete file.
                const fcb = new Fcb(this.memory.subarray(z80.regs.de));
                // TODO the filename can contain wildcards.
                this.log.write(`Deleting ${fcb.getFilename()}\n`);
                const pathname = this.makePathname(fcb);
                try {
                    fs.accessSync(pathname); // Throws if file doesn't exist.
                    fs.unlinkSync(pathname);
                    z80.regs.a = 0x00; // Success.
                } catch (err) {
                    // File doesn't exist.
                    z80.regs.a = 0xFF;
                }
                break;
            }

            case 20: { // Read sequential.
                const fcb = new Fcb(this.memory.subarray(z80.regs.de));
                let fd = fcb.fd;
                if (fd === 0) {
                    throw new Error("Reading from unopened FCB");
                }
                const recordNumber = fcb.currentRecord;
                this.log.write(`Sequential reading record number ${recordNumber} from ${fcb.getFilename()}\n`);
                fcb.dump(this.log, z80.regs.de);
                const bytesRead = fs.readSync(fd, this.memory, this.dma, RECORD_SIZE, recordNumber*RECORD_SIZE);
                if (bytesRead === 0) {
                    z80.regs.a = 0x01; // End of file.
                } else {
                    // Fill rest with ^Z.
                    this.memory.fill(26, this.dma + bytesRead, this.dma + RECORD_SIZE);
                    this.dumpDma();
                    z80.regs.a = 0x00;
                    fcb.currentRecord = recordNumber + 1;
                }
                z80.regs.l = z80.regs.a;
                z80.regs.h = 0x00;
                z80.regs.b = 0x00;
                break;
            }

            case 21: { // Write sequential.
                const fcb = new Fcb(this.memory.subarray(z80.regs.de));
                let fd = fcb.fd;
                if (fd === 0) {
                    throw new Error("Writing to unopened FCB");
                }
                const recordNumber = fcb.currentRecord;
                this.log.write(`Sequential writing record number ${recordNumber} to ${fcb.getFilename()}\n`);
                fcb.dump(this.log, z80.regs.de);
                this.dumpDma();
                let bytesWritten: number;
                try {
                    bytesWritten = fs.writeSync(fd, this.memory, this.dma, RECORD_SIZE, recordNumber*RECORD_SIZE);
                } catch (err) {
                    console.log("Can't write to file");
                    console.log(err);
                    await this.exit();
                    return;
                }
                if (bytesWritten !== RECORD_SIZE) {
                    throw new Error("Only wrote " + bytesWritten);
                }
                fcb.currentRecord = recordNumber + 1;
                z80.regs.a = 0x00; // Success.
                break;
            }

            case 22: { // Make file.
                const fcb = new Fcb(this.memory.subarray(z80.regs.de));
                fcb.clear();
                this.log.write("Making " + fcb.getFilename() + "\n");
                const pathname = this.makePathname(fcb);
                try {
                    fcb.fd = fs.openSync(pathname, "wx+");
                    z80.regs.a = 0x00; // Success.
                } catch (err) {
                    console.log("Can't make " + pathname);
                    fcb.fd = 0;
                    z80.regs.a = 0xFF; // Error.
                }
                break;
            }

            case 23: { // Rename file.
                const fcbSrc = new Fcb(this.memory.subarray(z80.regs.de));
                const fcbDest = new Fcb(this.memory.subarray(z80.regs.de + 16));
                this.log.write("Renaming " + fcbSrc.getFilename() + " to " + fcbDest.getFilename() + "\n");
                const pathnameSrc = this.makePathname(fcbSrc);
                const pathnameDest = this.makePathname(fcbDest);
                try {
                    fs.renameSync(pathnameSrc, pathnameDest);
                    z80.regs.a = 0x00; // Success.
                } catch (err) {
                    this.log.write("Error renaming: " + err);
                    z80.regs.a = 0xFF; // Error.
                }
                break;
            }

            case 25: { // Return current drive.
                z80.regs.a = this.currentDrive;
                break;
            }

            case 26: { // Set DMA address.
                this.dma = z80.regs.de;
                break;
            }

            case 33: { // Random access read record.
                const fcb = new Fcb(this.memory.subarray(z80.regs.de));
                let fd = fcb.fd;
                if (fd === 0) {
                    throw new Error("Reading from unopened FCB");
                }
                const recordNumber = fcb.randomRecord;
                this.log.write(`Random reading record number ${recordNumber} from ${fcb.getFilename()}\n`);
                z80.regs.a = 0x00;
                const bytesRead = fs.readSync(fd, this.memory, this.dma, RECORD_SIZE, recordNumber*RECORD_SIZE);
                if (bytesRead === 0) {
                    z80.regs.a = 0x01; // End of file.
                } else {
                    // Fill rest with ^Z.
                    for (let i = bytesRead; i < RECORD_SIZE; i++) {
                        this.memory[this.dma + i] = 26; // ^Z
                    }
                    this.dumpDma();
                }
                fcb.currentRecord = recordNumber;
                break;
            }

            case 34: { // Random access write record.
                const fcb = new Fcb(this.memory.subarray(z80.regs.de));
                let fd = fcb.fd;
                if (fd === 0) {
                    throw new Error("Writing to unopened FCB");
                }
                const recordNumber = fcb.randomRecord;
                this.log.write(`Random writing record number ${recordNumber} to ${fcb.getFilename()}\n`);
                this.dumpDma();
                const bytesWritten = fs.writeSync(fd, this.memory, this.dma, RECORD_SIZE, recordNumber*RECORD_SIZE);
                if (bytesWritten === 0) {
                    z80.regs.a = 0x05; // Out of disk space.
                } else {
                    z80.regs.a = 0x00; // Success.
                }
                fcb.currentRecord = recordNumber;
                break;
            }

            case 35: { // Compute file size.
                const fcb = new Fcb(this.memory.subarray(z80.regs.de));
                this.log.write(`Compute file size of ${fcb.getFilename()}\n`);
                try {
                    const stat = fs.statSync(this.makePathname(fcb));
                    const size = Math.ceil(stat.size/RECORD_SIZE);
                    this.log.write(`Size is ${size} records`);
                    fcb.randomRecord = size;
                    z80.regs.a = 0x00; // Success.
                } catch (err) {
                    this.log.write(`File not found`);
                    z80.regs.a = 0xFF; // Error
                }
                break;
            }

            default:
                this.log.write("Error: Unhandled CP/M syscall: " + f + "\n");
                break;
        }
    }

    /**
     * Some guest programs call the CBIOS directly. We intercept those calls here.
     */
    public async handleCbiosCall(z80: Z80) {
        const addr = z80.regs.pc - CBIOS_ADDRESS;
        if (addr % 3 !== 0) {
            throw new Error("CBIOS address is not multiple of 3");
        }
        const func = (addr / 3) as CbiosEntryPoint;
        this.log.write("CBIOS function " + CbiosEntryPoint[func] + "\n");

        switch (func) {
            case CbiosEntryPoint.CONST:
                z80.regs.a = this.keyQueue.length === 0 ? 0x00 : 0xFF;
                break;

            case CbiosEntryPoint.CONIN:
                z80.regs.a = await this.readStdin();
                break;

            case CbiosEntryPoint.CONOUT:
                process.stdout.write(String.fromCodePoint(z80.regs.c));
                break;

            case CbiosEntryPoint.BOOT:
            case CbiosEntryPoint.WBOOT:
            case CbiosEntryPoint.LIST:
            case CbiosEntryPoint.PUNCH:
            case CbiosEntryPoint.READER:
            case CbiosEntryPoint.HOME:
            case CbiosEntryPoint.SELDSK:
            case CbiosEntryPoint.SETTRK:
            case CbiosEntryPoint.SETSEC:
            case CbiosEntryPoint.SETDMA:
            case CbiosEntryPoint.READ:
            case CbiosEntryPoint.WRITE:
            case CbiosEntryPoint.LISTST:
            case CbiosEntryPoint.SECTRAN:
            default:
                this.log.write("Error: Unhandled CBIOS function: " + CbiosEntryPoint[func] + "\n");
                break;
        }
    }

    /**
     * Got a key from the keyboard. Queue it up or deliver it right away if someone's waiting
     * in readStdin().
     */
    public gotKey(key: number): void {
        if (this.keyResolve === undefined) {
            this.keyQueue.push(key);
        } else {
            const oldKeyResolve = this.keyResolve;
            this.keyResolve = undefined;
            oldKeyResolve(key);
        }
    }

    /**
     * Exit the CP/M emulator. Does not call its returned promise.
     */
    public async exit() {
        this.log.write("Exiting...\n");
        this.log.end(() => {
            this.printer.end(() => {
                process.exit();
            });
        });

        // Hang forever.
        return new Promise(resolve => {});
    }

    /**
     * Block until we have a key from stdin.
     */
    private async readStdin(): Promise<number> {
        return new Promise(resolve => {
            if (this.keyQueue.length === 0) {
                if (this.keyResolve !== undefined) {
                    throw new Error("Nested calls to readStdin");
                }
                this.keyResolve = resolve;
            } else {
                resolve(this.keyQueue.shift());
            }
        });
    }

    /**
     * Return the host directory for a FCB.
     */
    private getDriveDir(fcb: Fcb): string {
        // Handle '?' (0x3F) to mean the current drive.
        const drive = fcb.drive === 0 || fcb.drive === 0x3F ? this.currentDrive : fcb.drive - 1;
        const dir = this.driveDirMap.get(drive);
        if (dir === undefined) {
            throw new Error("No dir for drive " + drive);
        }

        return dir;
    }

    /**
     * Make a full pathname from an FCB.
     */
    private makePathname(fcb: Fcb): string {
        return path.join(this.getDriveDir(fcb), fcb.getFilename());
    }

    /**
     * Return the next directory entry in the list.
     */
    private searchForNextDirEntry(z80: Z80): void {
        // Get the next filename alphabetically.
        const filename = this.dirEntries.shift();
        if (filename === undefined) {
            // End of directory.
            z80.regs.a = 0xFF;
        } else {
            // Clear FCB area.
            this.memory.fill(0, this.dma, this.dma + 32);

            // Clear rest of DMA.
            this.memory.fill(0xE5, this.dma + 32, this.dma + RECORD_SIZE);

            // Get the name and extension.
            const parts = path.parse(filename);
            const name = parts.name;
            const ext = parts.ext.startsWith(".") ? parts.ext.substr(1) : parts.ext;

            // Start with spaces.
            this.memory.fill(0x20, this.dma + 1, this.dma + 12);

            // Fill name.
            for (let i = 0; i < name.length; i++) {
                this.memory[this.dma + 1 + i] = name.charCodeAt(i);
            }

            // Fill extension.
            for (let i = 0; i < ext.length; i++) {
                this.memory[this.dma + 9 + i] = ext.charCodeAt(i);
            }

            // Wrote in directory entry zero.
            z80.regs.a = 0x00;
        }
    }

    /**
     * Dump the record at the DMA location to the log file.
     */
    private dumpDma(): void {
        for (let i = 0; i < RECORD_SIZE; i += 16) {
            const address = this.dma + i;
            let row = toHex(address, 4) + "  ";

            for (let j = 0; j < 16; j++) {
                row += toHex(this.memory[address + j], 2) + " ";
                if (j == 7) {
                    row += " ";
                }
            }
            row += " |";
            for (let j = 0; j < 16; j++) {
                const ch = this.memory[address + j];
                row += ch >= 32 && ch < 127 ? String.fromCodePoint(ch) : ".";
            }
            row += "|\n";
            this.log.write(row);
        }
    }
}

/**
 * Create a map from PC location to disassembled instruction.
 */
function makeInstructionMap(bin: Uint8Array, org: number): Map<number, Instruction> {
    const disasm = new Disasm(bin);
    disasm.org = org;
    const instructions = disasm.disassembleAll();
    return new Map<number, Instruction>(
        instructions.map((instruction) => [instruction.address, instruction]));
}

program
    .option('--drive <dir>', 'dir to mount as drive A:')
    .arguments("<program.com>");

program.parse(process.argv);

if (program.args.length !== 1) {
    program.help();
}

const driveADir = program.drive ?? ".";
const binPathname: string = path.join(driveADir, program.args[0]);

// Set up logging.
const log = WRITE_LOG ? fs.createWriteStream("cpm.log") : new NullWritable();
const printer = WRITE_PRINTER ? fs.createWriteStream("cpm.prn") : new NullWritable();

// Load the binary and set up the virtual machine.
const bin = fs.readFileSync(binPathname);
const instructionMap = DUMP_ASSEMBLY ? makeInstructionMap(bin, LOAD_ADDRESS) : undefined;
const cpm = new Cpm(bin, log, printer);
cpm.setDrive(0, driveADir);
const z80 = new Z80(cpm);
z80.reset();
z80.regs.pc = LOAD_ADDRESS;

// Set up keyboard input.
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.on("keypress", async (str, key) => {
    // Quit on Ctrl-C.
    if (key.sequence === "\u0003") {
        await cpm.exit();
    } else if (str !== undefined) {
        cpm.gotKey(str.codePointAt(0));
    } else {
        for (let ch of key.sequence) {
            cpm.gotKey(ch.codePointAt(0));
        }
    }
});

// Execute one opcode and intercept any CP/M calls.
async function step() {
    // Show disassembly if necessary.
    if (instructionMap !== undefined) {
        const instruction = instructionMap.get(z80.regs.pc);
        if (instruction !== undefined) {
            if (instruction.label !== undefined) {
                log.write("                 " + instruction.label + ":\n");
            }
            log.write(toHex(instruction.address, 4) + " " + instruction.binText().padEnd(12) + "        " + instruction.toText() + "\n");
        }
    }

    z80.step();

    if (z80.regs.pc === BDOS_ADDRESS) {
        await cpm.handleBdosCall(z80);
    } else if (z80.regs.pc >= CBIOS_ADDRESS) {
        await cpm.handleCbiosCall(z80);
    } else if (z80.regs.pc === 0) {
        await cpm.exit();
    } else if (z80.regs.pc < LOAD_ADDRESS && z80.regs.pc !== CPM_CALL_ADDRESS) {
        log.write("Unhandled PC address: 0x" + toHex(z80.regs.pc, 4) + "\n");
    }
}

async function tick() {
    for (let i = 0; i < 100_000; i++) {
        await step();
    }
}
function go() {
   tick().then(r => setTimeout(go, 0));
}
go();
