/**
 * Side-effect module for tests whose fixtures are verbatim v18 devnet account bytes (PDAs and owners derived under wrapper
 * GnwdeQr...). Import it FIRST: ESM evaluates imports in order, so program-ids.ts then resolves that wrapper from env.
 * (node --test runs each file in its own process, so this cannot leak into another test file.)
 */
process.env.WRAPPER_PROGRAM_ID = "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ";
process.env.KEEPER_ALLOW_PROGRAM_ID_OVERRIDE = "1";
process.env.PERCOLATOR_SDK_ALLOW_PROGRAM_OVERRIDE = "1";
delete process.env.PROGRAM_ID;
