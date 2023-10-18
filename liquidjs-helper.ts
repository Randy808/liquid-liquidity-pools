import {
  Finalizer,
  Pset,
  Transaction,
} from "liquidjs-lib";
import * as liquid from "liquidjs-lib";
let ecc = require("tiny-secp256k1");
import { NETWORK } from "./constants";
import ElementsClient from "./elements-client";
import {
  IssueAssetResponse,
  SimplifiedVerboseGetRawTransactionResponse,
} from "./elements-client/module";

export interface SendResult {
  tx: SimplifiedVerboseGetRawTransactionResponse;
  outputIndex: number;
}

const elementsClient = new ElementsClient();

export async function issueAsset(
  amount: number,
  reissuanceTokenAmount: number = 0
): Promise<{ issuanceTxId: string; assetId: string }> {
  let issuanceResponse: IssueAssetResponse = await elementsClient.issueAsset(
    amount / 100_000_000,
    reissuanceTokenAmount
  );

  return {
    issuanceTxId: issuanceResponse.txid,
    assetId: issuanceResponse.asset,
  };
}

export function getCovenantAddress(
  covenantScriptASM: string,
  internalPublicKey: Buffer
): string {
  const leafScript = liquid.script.fromASM(covenantScriptASM);

  let leaves = [
    {
      scriptHex: leafScript.toString("hex"),
    },
  ];

  let hashTree = liquid.bip341.toHashTree(leaves);
  let bip341Factory = liquid.bip341.BIP341Factory(ecc);
  let output = bip341Factory.taprootOutputScript(internalPublicKey, hashTree);
  let p2trAddress = liquid.address.fromOutputScript(output, NETWORK);

  if (!p2trAddress) {
    throw new Error("Address could not be derived");
  }

  return p2trAddress;
}

function getOutputForAssetId(tx: any, assetId: string) {
  let { vout } = tx;

  for (let i = 0; i < vout.length; i++) {
    if (vout[i].asset == assetId && vout[i].scriptPubKey.asm) {
      return i;
    }
  }

  return -1;
}

function convertToBitcoinUnits(amount) {
  return amount / 100_000_000;
}

export async function spendToAddress({
  assetId,
  address,
  amount: amountInSatoshis,
}: {
  assetId: string;
  address: string;
  amount: number;
}): Promise<SendResult> {
  let sendToAddressTxId = await elementsClient.sendToAddress(
    address,
    convertToBitcoinUnits(amountInSatoshis),
    assetId
  );
  let tx = await elementsClient.getRawTransaction(sendToAddressTxId);
  let outputIndex = getOutputForAssetId(tx, assetId);

  return {
    tx,
    outputIndex,
  };
}

export function toXOnly(key: Buffer) {
  return key.subarray(1);
}

export function signInput(pset: Pset, input: number, inputKeypair: any) {
  const preimage = pset.getInputPreimage(
    input,
    Transaction.SIGHASH_ALL,
    NETWORK.genesisBlockHash
  );

  if (!pset.inputs[input]) {
    return;
  }

  pset.inputs[input].partialSigs = [];
  pset.inputs[input].partialSigs!.push({
    pubkey: inputKeypair.publicKey,
    signature: liquid.script.signature.encode(
      inputKeypair.sign(preimage),
      Transaction.SIGHASH_ALL
    ),
  });

  let finalizer = new Finalizer(pset);
  finalizer.finalizeInput(input);
}
