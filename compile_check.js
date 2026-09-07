const solc = require('solc');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync('contracts/RealEstate.sol', 'utf8');

function findImports(importPath) {
  try {
    // resolve @openzeppelin and relative imports from node_modules
    const full = path.join('node_modules', importPath);
    return { contents: fs.readFileSync(full, 'utf8') };
  } catch (e) {
    return { error: 'File not found: ' + importPath };
  }
}

const input = {
  language: 'Solidity',
  sources: { 'RealEstate.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

const errors = (out.errors || []).filter(e => e.severity === 'error');
const warnings = (out.errors || []).filter(e => e.severity === 'warning');

if (errors.length) {
  console.log('COMPILE ERRORS:');
  errors.forEach(e => console.log('  ' + e.formattedMessage));
  process.exit(1);
}
console.log('COMPILED OK.');
console.log('Warnings:', warnings.length);
warnings.slice(0, 5).forEach(w => console.log('  - ' + (w.message || '').split('\n')[0]));

const contracts = out.contracts['RealEstate.sol'];
console.log('\nContracts produced:');
for (const name of Object.keys(contracts)) {
  const bc = contracts[name].evm.bytecode.object;
  console.log(`  ${name}: ${contracts[name].abi.length} ABI entries, ${bc.length/2} bytes`);
}

// save ABIs + bytecode for the frontend/deploy
const artifacts = {};
for (const name of Object.keys(contracts)) {
  artifacts[name] = {
    abi: contracts[name].abi,
    bytecode: '0x' + contracts[name].evm.bytecode.object,
  };
}
fs.writeFileSync('artifacts_compiled.json', JSON.stringify(artifacts, null, 2));
console.log('\nSaved ABIs + bytecode to artifacts_compiled.json');
