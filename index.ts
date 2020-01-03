import program from "commander";
import * as fs from "fs";
import * as path from "path";
import readline from "readline";
import {Writable} from "stream";
import {toHex} from "z80-base";
import {Disasm, Instruction} from "z80-disasm";
import {Hal, Z80} from "z80-emulator";

const LOAD_ADDRESS = 0x0100;
const CPM_CALL_ADDRESS = 0x0005;
const RECORD_SIZE = 128;
const DEFAULT_DMA = 0x0080;
const DUMP_ASSEMBLY = false;
const FCB_LENGTH = 33;
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

// http://members.iinet.net.au/~daveb/cpm/fcb.html
class Fcb {
    private readonly mem: Uint8Array;

    constructor(mem: Uint8Array) {
        this.mem = mem;
    }

    get drive(): number {
        return this.mem[0];
    }

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

    get recordNumber(): number {
        return this.mem[0x21] | (this.mem[0x22] << 8);
    }

    set recordNumber(n: number) {
        this.mem[0x21] = n & 0xFF;
        this.mem[0x22] = (n >> 8) & 0xFF;
    }

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

    public dump(out: Writable): void {
        out.write("FCB: " + this.drive + ":" + this.name + "." + this.fileType + "\n");
    }

    public getFilename(): string {
        return this.name + "." + this.fileType;
    }

    public static blankOut(memory: Uint8Array, address: number): void {
        // Current drive.
        memory[address] = 0;
        for (let i = 0; i < 11; i++) {
            // Spaces for "no filename".
            memory[address + i + 1] = 0x20;
        }
    }
}

class Cpm implements Hal {
    private memory = new Uint8Array(64*1024);
    private readonly log: Writable;
    private readonly printer: Writable;
    private currentDrive = 0; // 0 = A, 1 = B, ...
    private keyResolve: ((key: number) => void) | undefined;
    private keyQueue: number[] = [];
    private driveDirMap = new Map<number, string>();
    private fcbToFdMap = new Map<number, number>();
    private dma = DEFAULT_DMA;

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

        for (let i = 0; i < CBIOS_ENTRY_POINT_COUNT; i++) {
            this.memory[CBIOS_ADDRESS + i*3] = 0xC9; // RET
        }

        // Blank out command-line FCBs.
        Fcb.blankOut(this.memory, FCB1_ADDRESS);
        Fcb.blankOut(this.memory, FCB2_ADDRESS);
    }

    public setDrive(drive: number, dir: string): void {
        this.driveDirMap.set(drive, dir);
    }

    public tStateCount: number = 0;
    public readMemory(address: number): number {
        const value = this.memory[address];
        if (address < LOAD_ADDRESS &&
            !(address >= CPM_CALL_ADDRESS && address < CPM_CALL_ADDRESS + 3) &&
            !(address >= FCB1_ADDRESS && address < FCB1_ADDRESS + FCB_LENGTH)) {

            this.log.write("Reading " + toHex(value, 2) + " from " + toHex(address, 4) + "\n");
        }
        return value;
    }

    public writeMemory(address: number, value: number): void {
        if (address < LOAD_ADDRESS &&
            !(address >= FCB1_ADDRESS && address < FCB1_ADDRESS + FCB_LENGTH)) {

            this.log.write("Writing " + toHex(value, 2) + " to " + toHex(address, 4) + "\n");
        }
        this.memory[address] = value;
    }

    public contendMemory(address: number): void {
    }

    public readPort(address: number): number {
        return 0;
    }

    public writePort(address: number, value: number): void {
    }

    public contendPort(address: number): void {
    }

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
                fcb.dump(this.log);
                const drive = fcb.drive === 0 ? this.currentDrive : fcb.drive - 1;
                const dir = this.driveDirMap.get(drive);
                if (dir === undefined) {
                    throw new Error("No dir for drive " + drive);
                }
                const pathname = path.join(dir, fcb.getFilename());
                this.log.write("Opening " + pathname + "\n");
                let fd: number;
                try {
                    fd = fs.openSync(pathname, "r");
                    this.fcbToFdMap.set(z80.regs.de, fd);
                    fcb.recordNumber = 0;
                    z80.regs.a = 0x00; // Success.
                } catch (err) {
                    console.log("Can't open " + pathname);
                    this.fcbToFdMap.delete(z80.regs.de);
                    z80.regs.a = 0xFF; // Error.
                }
                break;
            }

            case 20: { // Read sequential.
                const fcb = new Fcb(this.memory.subarray(z80.regs.de));
                let fd = this.fcbToFdMap.get(z80.regs.de);
                if (fd === undefined) {
                    throw new Error("Reading from unopened FCB");
                }
                const recordNumber = fcb.recordNumber;
                this.log.write("Reading record number " + recordNumber + "\n");
                z80.regs.a = 0x00;
                const bytesRead = fs.readSync(fd, this.memory, this.dma, RECORD_SIZE, recordNumber*RECORD_SIZE);
                if (bytesRead === 0) {
                    z80.regs.a = 0xFF; // End of file.
                } else if (bytesRead !== RECORD_SIZE) {
                    // Fill rest with ^Z.
                    for (let i = bytesRead; i < RECORD_SIZE; i++) {
                        this.memory[this.dma + i] = 26; // ^Z
                    }
                }
                fcb.recordNumber = recordNumber + 1;
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
                let fd = this.fcbToFdMap.get(z80.regs.de);
                if (fd === undefined) {
                    throw new Error("Reading from unopened FCB");
                }
                const recordNumber = fcb.recordNumber;
                this.log.write("Reading record number " + recordNumber + "\n");
                z80.regs.a = 0x00;
                const bytesRead = fs.readSync(fd, this.memory, this.dma, RECORD_SIZE, recordNumber*RECORD_SIZE);
                if (bytesRead === 0) {
                    z80.regs.a = 0x01; // End of file.
                } else if (bytesRead !== RECORD_SIZE) {
                    // Fill rest with ^Z.
                    for (let i = bytesRead; i < RECORD_SIZE; i++) {
                        this.memory[this.dma + i] = 26; // ^Z
                    }
                }
                break;
            }

            default:
                this.log.write("Error: Unhandled CP/M syscall: " + f + "\n");
                // process.exit();
                break;
        }
    }

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
const log = fs.createWriteStream("cpm.log");
const printer = fs.createWriteStream("cpm.prn");

const bin = fs.readFileSync(binPathname);
const disasm = new Disasm(bin);
disasm.org = LOAD_ADDRESS;
const instructions = disasm.disassembleAll();
const instructionMap = new Map<number, Instruction>(
    instructions.map((instruction) => [instruction.address, instruction]));
const cpm = new Cpm(bin, log, printer);
cpm.setDrive(0, driveADir);
const z80 = new Z80(cpm);
z80.reset();
z80.regs.pc = LOAD_ADDRESS;

// Set up keyboard input.
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.on("keypress", (str, key) => {
    // Quit on Ctrl-C.
    if (key.sequence === "\u0003") {
        log.end(() => {
            printer.end(() => {
                process.exit();
            });
        });
    }
    if (str !== undefined) {
        cpm.gotKey(str.codePointAt(0));
    } else {
        for (let ch of key.sequence) {
            cpm.gotKey(ch.codePointAt(0));
        }
    }
});

async function step() {
    if (DUMP_ASSEMBLY) {
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
        process.exit();
    } else if (z80.regs.pc < LOAD_ADDRESS && z80.regs.pc !== CPM_CALL_ADDRESS) {
        log.write("Unhandled PC address: 0x" + toHex(z80.regs.pc, 4) + "\n");
    }
}

async function tick() {
    const before = Date.now();
    for (let i = 0; i < 100_000; i++) {
        await step();
    }
    const elapsed = Date.now() - before;
    log.write("Tick time: " + elapsed + " ms\n");
}
function go() {
   tick().then(r => setTimeout(go, 0));
}
go();
