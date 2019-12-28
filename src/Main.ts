// Alice 3 emulation for https://github.com/lkesteloot/z80-emulator

// import {Delegate, Register, Runner, toHex, hi} from "z80-test";
import {hi, lo} from "z80-base";
import fs from "fs";
import readline from "readline";
import {Z80,Hal} from "z80-emulator";

/**
 * Alice 3 HAL
 */
class Alice3Machine implements Hal {
    public memory: Uint8Array = new Uint8Array(64*1024);
    public tStateCount = 0;

    private diskFileNames: Array<string>;
    private diskFiles: Array<number> = [];

    private alice3CONOUTPort = 128;             // Propeller port, console output
    private alice3CommandPort = 0;              // Access to ARM-hosted I/O

    private alice3PortReadQueue: Array<number> = [];
    private alice3KeyQueue: Array<number> = [];
    private alice3CommandBytes: Array<number> = [];

    private alice3ResponsePollAgain = 0;        // Operation not complete on IO board
    private alice3ResponseSuccess = 1;          // Command received, operation succeeded on IO board
    private alice3ResponseFailure = 0xFF;       // Command received, operation failed on IO board
    private alice3ResponseReady = 1;            // Command received by IO board, results follow
    private alice3ResponseNotReady = 0xFF;      // Command received by IO board, results not ready, send command again

    private alice3CommandRead = 1;              // READ sector
    private alice3CommandWrite = 2;             // WRITE sector
    private alice3CommandCONST = 3;             // CONST
    private alice3CommandCONIN = 4;             // CONIN - DOES NOT BLOCK, POLL CONST
    private alice3CommandSerout = 5;            // SEROUT
    private alice3CommandReadSum = 6;           // READ sector and give checksum
    private alice3CommandWriteSum = 7;          // WRITE sector but verify sum first
    private alice3CommandReadDMA = 9;           // READ sector using DMA
    private alice3CommandWriteDMA = 10;         // WRITE sector using DMA

    private sectorSize = 128;
    private sectorsPerTrack = 64;
    private buffer: Buffer;

    constructor(memory: Buffer, diskFileNames: Array<string>) {
        // Copy initial memory into Alice 3 machine RAM
        for(var i = 0; i < memory.length; i++) {
            this.memory[i] = memory[i];
        }

        this.diskFileNames = diskFileNames;
        diskFileNames.forEach((filename) => { 
            this.diskFiles.push(fs.openSync(filename, "r+"));
        });

        this.buffer = Buffer.alloc(this.sectorSize);
    }

    public addKey(key: number): void {
        this.alice3KeyQueue.push(key);
    }

    public reset(): void {
        this.memory.fill(0);
        this.tStateCount = 0;
    }

    contendMemory(address: number): void {
    }

    contendPort(address: number): void {
    }

    readMemory(address: number): number {
        return this.memory[address];
    }

    readPort(address: number): number {
        address = lo(address);
        if(address == this.alice3CommandPort) {
            if(this.alice3PortReadQueue.length > 0) {
                var value = this.alice3PortReadQueue.shift()!;
                return value;
            } else {
                return 0;
            }
        } else {
            console.log("WARNING: read unknown port " + address);
        }
        return 0;
    }

    writeMemory(address: number, value: number): void {
        this.memory[address] = value;
    }

    handleCONST(): void {
        if(this.alice3KeyQueue.length > 0) {
            this.alice3PortReadQueue.push(this.alice3ResponseReady);
        } else {
            this.alice3PortReadQueue.push(this.alice3ResponseNotReady);
        }
    }

    handleCONIN(): void {
        if(this.alice3KeyQueue.length > 0) {
            this.alice3PortReadQueue.push(this.alice3ResponseReady);
            this.alice3PortReadQueue.push(this.alice3KeyQueue.shift()!);
        } else {
            this.alice3PortReadQueue.push(this.alice3ResponseNotReady);
        }
    }

    calculateSum(buffer: Buffer) : number {
        let sum = 0;
        this.buffer.forEach((byte) => { sum += byte; });
        return sum;
    }

    handleReadDMA(disk: number, sector: number, track: number, address: number) : void
    {
        let location = (track * this.sectorsPerTrack + sector) * this.sectorSize;
        let read = fs.readSync(this.diskFiles[disk], this.buffer, 0, this.sectorSize, location);
        // console.log("read " + disk + ", " + sector + ", " + track + " (" + location + ") to " + address + " checksum " + this.calculateSum(this.buffer));
        if(read != this.sectorSize) {
            console.log("only read " + read + " bytes");
            process.exit();
        }
        this.alice3PortReadQueue.push(0);
        this.alice3PortReadQueue.push(0);
        this.alice3PortReadQueue.push(0);
        this.alice3PortReadQueue.push(this.alice3ResponseSuccess);
        this.buffer.forEach((byte) => { this.memory[address] = byte; address += 1; });
    }

    handleWriteDMA(disk: number, sector: number, track: number, address: number) : void
    {
        let location = (track * this.sectorsPerTrack + sector) * this.sectorSize;
        for(var i = 0; i < this.sectorSize; i++) {
            this.buffer[i] = this.memory[address + i];
        }
        // console.log("write " + disk + ", " + sector + ", " + track + " (" + location + ") from " + address + " checksum " + this.calculateSum(this.buffer));
        let wrote = fs.writeSync(this.diskFiles[disk], this.buffer, 0, this.sectorSize, location);
        if(wrote != this.sectorSize) {
            console.log("only wrote " + wrote + " bytes");
            process.exit();
        }
        fs.fsyncSync(this.diskFiles[disk]);
        this.alice3PortReadQueue.push(this.alice3ResponseSuccess);
    }

    handleReadSum(disk: number, sector: number, track: number) : void
    {
        let location = (track * this.sectorsPerTrack + sector) * this.sectorSize;
        fs.readSync(this.diskFiles[disk], this.buffer, 0, this.sectorSize, location);
        let sum = this.calculateSum(this.buffer);
        this.alice3PortReadQueue.push(this.alice3ResponseSuccess);
        this.buffer.forEach((byte) => { this.alice3PortReadQueue.push(byte); });
        this.alice3PortReadQueue.push(lo(sum));
        this.alice3PortReadQueue.push(hi(sum));
    }

    writePort(address: number, value: number): void {
        address = lo(address);

        if(address == this.alice3CONOUTPort) {

            process.stdout.write(String.fromCharCode(value));

        } else if(address == this.alice3CommandPort) {

            var currentLength = this.alice3CommandBytes.push(value);

            if(this.alice3CommandBytes[0] == this.alice3CommandCONST) {
                if(currentLength >= 1) {
                    this.alice3CommandBytes.shift();
                    this.handleCONST();
                }
            } else if(this.alice3CommandBytes[0] == this.alice3CommandCONIN) {
                if(currentLength >= 1) {
                    this.alice3CommandBytes.shift();
                    this.handleCONIN();
                }
            } else if(this.alice3CommandBytes[0] == this.alice3CommandReadSum) {
                if(currentLength >= 6) {
                    let command = this.alice3CommandBytes.splice(0, 6);
                    let disk = command[1];
                    let sector = command[2] + 256 * command[3];
                    let track = command[4] + 256 * command[5];
                    this.handleReadSum(disk, sector, track);
                }
            } else if(this.alice3CommandBytes[0] == this.alice3CommandReadDMA) {
                if(currentLength >= 8) {
                    let command = this.alice3CommandBytes.splice(0, 8);
                    let disk = command[1];
                    let sector = command[2] + 256 * command[3];
                    let track = command[4] + 256 * command[5];
                    let address = command[6] + 256 * command[7];
                    this.handleReadDMA(disk, sector, track, address);
                }
            } else if(this.alice3CommandBytes[0] == this.alice3CommandWriteDMA) {
                if(currentLength >= 8) {
                    let command = this.alice3CommandBytes.splice(0, 8);
                    let disk = command[1];
                    let sector = command[2] + 256 * command[3];
                    let track = command[4] + 256 * command[5];
                    let address = command[6] + 256 * command[7];
                    this.handleWriteDMA(disk, sector, track, address);
                }
            } else if(currentLength == 1) {
                console.log("unimplemented alice command byte " + value + " to port " + address);
                process.exit();
            }
        } else {
            console.log("unknown write " + value + " to port " + address);
            process.exit();
        }
    }
}

function usage(argv0: string) {
    console.log("usage: " + process.argv0 + " [options] memoryimage.bin");
    console.log("options:");
    console.log("\t--disk disk.img");
}

var diskFileNames: Array<string> = [];

// first argument is node, second is js name
process.argv.shift();
process.argv.shift();
while(process.argv.length > 1) {
    if(process.argv[0] == "--disk") {
        if(process.argv.length < 2) {
            usage(process.argv0);
            process.exit();
        }
        diskFileNames.push(process.argv[1]);
        process.argv.splice(0, 2);
    }
}

if(process.argv.length < 1) {
    usage(process.argv0);
    process.exit()
}

var memoryFileName = process.argv[0];

// Read initial memory, including ROM
let initialMemory = fs.readFileSync(memoryFileName);

// Set up raw keyboard access
// const readline = require('readline');
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.on('keypress', (str, key) => {
    if(key.sequence === '\u0003') {
        process.exit();
    }
    alice3.addKey(str.charCodeAt(0));
});

let alice3 = new Alice3Machine(initialMemory, diskFileNames);
let z80 = new Z80(alice3);

z80.reset();

setInterval(() => {
    var i;
    for(i = 0; i < 2000; i++) {
        z80.step();
    }
}, 1);
