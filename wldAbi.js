// wldAbi.js (frontend y/o backend)
export const WLD_ABI = [
  // balanceOf(address)
  {
    "constant": true,
    "inputs": [{ "name": "account", "type": "address" }],
    "name": "balanceOf",
    "outputs": [{ "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },

  // transfer(address to, uint256 value)
  {
    "constant": false,
    "inputs": [
      { "name": "to", "type": "address" },
      { "name": "value", "type": "uint256" }
    ],
    "name": "transfer",
    "outputs": [{ "name": "", "type": "bool" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },

  // event Transfer(address indexed from, address indexed to, uint256 value)
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true,  "name": "from", "type": "address" },
      { "indexed": true,  "name": "to",   "type": "address" },
      { "indexed": false, "name": "value","type": "uint256" }
    ],
    "name": "Transfer",
    "type": "event"
  }
];
