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
const DEFAULT_DMA = 0x80;
const DUMP_ASSEMBLY = false;
const FCB_LENGTH = 33;
const FCB1_ADDRESS = 0x5C;
const FCB2_ADDRESS = 0x6C;

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

        // Put a "ret" at the CP/M syscall address.
        this.memory[CPM_CALL_ADDRESS] = 0xC9;

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
        if (address < LOAD_ADDRESS && address != CPM_CALL_ADDRESS &&
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

    public async handleSyscall(z80: Z80) {
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
                const ch = value < 0x20 ? "0x" + toHex(value, 2) : String.fromCodePoint(value);
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
                    z80.regs.a = 0x00; // Success.
                } catch (err) {
                    console.log("Can't open " + pathname);
                    this.fcbToFdMap.delete(z80.regs.de);
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
                let fd = this.fcbToFdMap.get(z80.regs.de);
                if (fd === undefined) {
                    throw new Error("Reading from unopened FCB");
                }
                const recordNumber = fcb.recordNumber;
                this.log.write("Reading record number " + recordNumber + "\n");
                const bytesRead = fs.readSync(fd, this.memory, this.dma, RECORD_SIZE, recordNumber*RECORD_SIZE);
                if (bytesRead !== RECORD_SIZE) {
                    throw new Error("Read only " + bytesRead + " bytes");
                }
                fcb.recordNumber = recordNumber + 1;
                break;
            }

            default:
                console.log("Unhandled CP/M syscall: " + f + "\n");
                // process.exit();
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
    cpm.gotKey(str.codePointAt(0));
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

    if (z80.regs.pc === CPM_CALL_ADDRESS) {
        await cpm.handleSyscall(z80);
    } else if (z80.regs.pc < LOAD_ADDRESS) {
        console.log("Unhandled PC address: 0x" + toHex(z80.regs.pc, 4) + "\n");
        // process.exit();
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
