# CP/M emulator

This program runs CP/M 2.2 programs by emulating the BDOS and CBIOS on a modern Unix machine.

    % npm install
    % npm run build
    % node index.js --drive cpm-programs ZORK1.COM

This presents the `cpm-programs` directory as drive A:, loads `ZORK1.COM` from within it, and
executes it. When `ZORK1.COM` reads the `ZORK1.DAT` file, it'll be read from the `cpm-programs`
directory.

Status: Can run Sargon chess and the Zork series. Can load, compile, and run a Pascal program
in Turbo Pascal, but doesn't handle the full-screen editor well. Most BDOS and CBIOS calls are
not implemented.

# License

Copyright &copy; Lawrence Kesteloot, [MIT license](LICENSE).

