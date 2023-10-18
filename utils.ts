import * as liquid from "liquidjs-lib";
import { Transaction, witnessStackToScriptWitness } from "liquidjs-lib";
import { SendResult } from "./liquidjs-helper";
import { INTERNAL_PUBLIC_KEY } from "./constants";

// Always remember to fix rounding in js: https://techformist.com/problems-with-decimal-multiplication-javascript/
// https://stackoverflow.com/questions/9993266/javascript-multiply-not-precise
export function fixRounding(value, precision) {
  var power = Math.pow(10, precision || 0);
  return Math.round(value * power) / power;
}

export function createInput(sendResult: SendResult) {
  let tx = sendResult.tx;

  // Reverse because PsetInput takes in txid in little-endian
  let psetInput = new liquid.PsetInput(
    Buffer.from(tx.txid, "hex").reverse(),
    sendResult.outputIndex,
    Transaction.DEFAULT_SEQUENCE
  );

  let utxo = tx.vout[sendResult.outputIndex];

  let nonce = Buffer.from("00", "hex");

  psetInput.witnessUtxo = {
    asset: Buffer.concat([
      Buffer.from("01", "hex"),
      Buffer.from(utxo.asset, "hex").reverse(),
    ]),
    script: Buffer.from(utxo.scriptPubKey.hex, "hex"),
    value: liquid.confidential.satoshiToConfidentialValue(
      // utxo.value is denominated in Bitcoin so it must be converted to a satoshi count
      fixRounding(utxo.value * 100_000_000, 0)
    ),
    nonce,
  };

  psetInput.sighashType = Transaction.SIGHASH_ALL;

  return psetInput;
}

export function createInput2(
  txid: string,
  outputIndex: number,
  assetId: string,
  witnessScriptASM: string | undefined | null,
  scriptPubKeyHex,
  valueInSatoshis
) {
  // Reverse because PsetInput takes in txid in little-endian
  let psetInput = new liquid.PsetInput(
    Buffer.from(txid, "hex").reverse(),
    outputIndex,
    Transaction.DEFAULT_SEQUENCE
  );

  let nonce = Buffer.from("00", "hex");

  if (witnessScriptASM) {
    let witnessScript = liquid.script.fromASM(witnessScriptASM)
    psetInput.witnessScript = witnessScript;
    let leaves = [
      {
        scriptHex: witnessScript.toString("hex"),
      },
    ];
  
    let leafHash = liquid.bip341.tapLeafHash(leaves[0]);
    let hashTree = liquid.bip341.toHashTree(leaves);

    let ecc = require("tiny-secp256k1");
    const bip341Factory = liquid.bip341.BIP341Factory(ecc);
  
    // Path will always be '[]' since we only have one script in tree
    let path = liquid.bip341.findScriptPath(hashTree, leafHash);
    let taprootStack = bip341Factory.taprootSignScriptStack(
      INTERNAL_PUBLIC_KEY,
      leaves[0],
      hashTree.hash,
      path
    );

    psetInput.finalScriptWitness = witnessStackToScriptWitness([
      ...taprootStack,
    ]);
  }

  psetInput.witnessUtxo = {
    asset: Buffer.concat([
      Buffer.from("01", "hex"),
      Buffer.from(assetId, "hex").reverse(),
    ]),
    script: Buffer.from(scriptPubKeyHex, "hex"),
    value: liquid.confidential.satoshiToConfidentialValue(
      // utxo.value is denominated in Bitcoin so it must be converted to a satoshi count
      fixRounding(valueInSatoshis, 0)
    ),
    nonce,
  };

  psetInput.sighashType = Transaction.SIGHASH_ALL;

  return psetInput;
}
