import * as liquid from "liquidjs-lib";
import {
  issueAsset,
  getCovenantAddress,
  spendToAddress as spendToAddress,
  SendResult,
  signInput,
} from "./liquidjs-helper";
import { keypair } from "./keys";
import {
  INTERNAL_PUBLIC_KEY,
  ISSUANCE_AMOUNT_IN_SATOSHIS,
  LBTC_ASSET_ID,
  NETWORK,
  TRANSACTION_FEE_IN_SATOSHIS,
} from "./constants";
import { createInput, createInput2 } from "./utils";
import { Extractor, Finalizer, Pset, PsetGlobal } from "liquidjs-lib";
import ElementsClient from "./elements-client";

function getLiquidityPoolScript(
  assetA: string,
  assetB: string,
  reserveProduct: number
) {
  const reserveProductBuffer = Buffer.allocUnsafe(8);
  reserveProductBuffer.writeBigInt64LE(BigInt(reserveProduct));

  assetA = Buffer.from(assetA, "hex").reverse().toString("hex");
  assetB = Buffer.from(assetB, "hex").reverse().toString("hex");
  return (
    `OP_0 OP_INSPECTINPUTASSET OP_DROP ${assetA} OP_EQUALVERIFY ` +
    `OP_0 OP_INSPECTOUTPUTASSET OP_DROP ${assetA} OP_EQUALVERIFY ` +
    `OP_1 OP_INSPECTINPUTASSET OP_DROP ${assetB} OP_EQUALVERIFY ` +
    `OP_1 OP_INSPECTOUTPUTASSET OP_DROP ${assetB} OP_EQUALVERIFY ` +
    //inspect the first and second input come from the same transaction
    //Drop the vout and outpoint flag
    `OP_0 OP_INSPECTINPUTOUTPOINT OP_DROP OP_DROP ` +
    `OP_1 OP_INSPECTINPUTOUTPOINT OP_DROP OP_DROP ` +
    `OP_EQUALVERIFY ` +
    `OP_0 OP_INSPECTOUTPUTVALUE OP_DROP ` +
    `OP_1 OP_INSPECTOUTPUTVALUE OP_DROP OP_MUL64 OP_VERIFY ` +
    `OP_DUP OP_TOALTSTACK ` + //duplicate the output product
    //sanity check to make sure product is always increasing
    `${reserveProductBuffer.toString(
      "hex"
    )} OP_GREATERTHANOREQUAL64 OP_VERIFY ` +
    //stack:
    //Check that the drift from precision loss isn't too big
    `OP_0 OP_INSPECTINPUTVALUE OP_DROP ` +
    `OP_1 OP_INSPECTINPUTVALUE OP_DROP ` +
    `OP_2DUP ` +
    //stack: in0 in1 in0 in1
    //Get the sum of values and send to alt stack
    `OP_ADD64 OP_VERIFY OP_TOALTSTACK ` +
    //stack: in0 in1
    //get the input product
    `OP_MUL64 OP_VERIFY ` +
    //stack: inputProduct
    //altstack: outputProduct inputSum
    //Check to make sure: (inputProduct + inputSum) > outputProduct
    //The outputProduct's drift should be bounded by the input sum
    `OP_FROMALTSTACK OP_ADD64 OP_VERIFY OP_FROMALTSTACK OP_GREATERTHAN64 OP_VERIFY ` +
    //Make sure first output maintains the script
    `OP_0 OP_INSPECTINPUTSCRIPTPUBKEY OP_VERIFY ` +
    `OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY OP_VERIFY ` +
    `OP_EQUALVERIFY ` +
    //Make sure second output maintains the script
    `OP_1 OP_INSPECTINPUTSCRIPTPUBKEY OP_VERIFY ` +
    `OP_1 OP_INSPECTOUTPUTSCRIPTPUBKEY OP_VERIFY ` +
    `OP_EQUALVERIFY ` +
    //OP_1 to indicate success
    `OP_1`
  );
}

async function main() {
  let additionalAssetA = 100000;

  console.log("Sending LBTC to test address...");
  let { address: keypairAddress } = liquid.payments.p2wpkh({
    pubkey: keypair.publicKey,
    network: NETWORK,
  });

  if (!keypairAddress) {
    return;
  }

  const LBTC_ISSUANCE = 100_000;
  let funding: SendResult = await spendToAddress({
    assetId: LBTC_ASSET_ID,
    address: keypairAddress!,
    amount: LBTC_ISSUANCE,
  });
  console.log(`sendToAddress (BTC) result: ${funding.tx.txid}\n\n`);

  /************************/

  console.log("Issuing new asset...");

  let assetAIssuanceAmount = ISSUANCE_AMOUNT_IN_SATOSHIS;
  let { assetId: assetA } = await issueAsset(
    assetAIssuanceAmount + additionalAssetA
  );
  console.log(`Generated asset id ${assetA}\n\n`);

  let client = new ElementsClient();

  let spendA = await spendToAddress({
    assetId: assetA,
    address: keypairAddress,
    amount: assetAIssuanceAmount,
  });

  console.log("Issuing new asset...");
  let assetBIssuanceAmount = ISSUANCE_AMOUNT_IN_SATOSHIS * 2;
  let { assetId: assetB } = await issueAsset(assetBIssuanceAmount);

  console.log(`Generated asset id ${assetB}\n\n`);
  let spendB = await spendToAddress({
    assetId: assetB,
    address: keypairAddress,
    amount: assetBIssuanceAmount,
  });

  /************************/

  console.log("Creating covenant address...");

  //The product of the asset amounts going into the pool.
  //The real value of the reserve asset amounts should be the same
  let reserveProduct = assetAIssuanceAmount * assetBIssuanceAmount;
  let liquidityPoolScript = getLiquidityPoolScript(
    assetA,
    assetB,
    reserveProduct
  );

  let covenantAddress = await getCovenantAddress(
    liquidityPoolScript,
    INTERNAL_PUBLIC_KEY
  );

  /************************/
  //Spend to pool covenant
  /************************/

  let inputs: any[] = [];
  inputs.push(createInput(spendA));
  inputs.push(createInput(spendB));
  inputs.push(createInput(funding));

  let changeAmount = LBTC_ISSUANCE - TRANSACTION_FEE_IN_SATOSHIS;

  let outputs = [
    new liquid.PsetOutput(
      assetAIssuanceAmount,
      Buffer.from(assetA, "hex").reverse(),
      liquid.address.toOutputScript(covenantAddress)
    ),
    new liquid.PsetOutput(
      assetBIssuanceAmount,
      Buffer.from(assetB, "hex").reverse(),
      liquid.address.toOutputScript(covenantAddress)
    ),
    new liquid.PsetOutput(
      TRANSACTION_FEE_IN_SATOSHIS,
      Buffer.from(LBTC_ASSET_ID, "hex").reverse(),
      Buffer.alloc(0)
    ),
    new liquid.PsetOutput(
      changeAmount,
      Buffer.from(LBTC_ASSET_ID, "hex").reverse(),
      liquid.address.toOutputScript(keypairAddress)
    ),
  ];

  let pset = new Pset(
    new PsetGlobal(2, inputs.length, outputs.length),
    inputs,
    outputs
  );

  signInput(pset, 0, keypair);
  signInput(pset, 1, keypair);
  signInput(pset, 2, keypair);

  let finalizer = new Finalizer(pset);
  finalizer.finalize();

  const tx = Extractor.extract(pset);
  const hex = tx.toHex();
  console.log(hex);
  let txid = await client.sendRawTransaction(hex);

  inputs = [];

  /************************/
  //Spend from pool covenant
  /************************/

  let spendA2 = await spendToAddress({
    assetId: assetA,
    address: keypairAddress,
    amount: additionalAssetA,
  });

  inputs.push(
    createInput2(
      txid,
      0,
      assetA,
      liquidityPoolScript,
      liquid.address.toOutputScript(covenantAddress),
      assetAIssuanceAmount
    )
  );

  inputs.push(
    createInput2(
      txid,
      1,
      assetB,
      liquidityPoolScript,
      liquid.address.toOutputScript(covenantAddress),
      assetBIssuanceAmount
    )
  );

  //Funding
  inputs.push(
    createInput2(
      txid,
      3,
      LBTC_ASSET_ID,
      null,
      liquid.address.toOutputScript(keypairAddress),
      changeAmount
    )
  );

  inputs.push(createInput(spendA2));

  let assetASwapInAmount = 6;
  let assetABalance = additionalAssetA - assetASwapInAmount;
  let assetBSwapOutAmount = 10;

  outputs = [
    new liquid.PsetOutput(
      assetAIssuanceAmount + assetASwapInAmount,
      Buffer.from(assetA, "hex").reverse(),
      liquid.address.toOutputScript(covenantAddress)
    ),
    new liquid.PsetOutput(
      assetBIssuanceAmount - assetBSwapOutAmount,
      Buffer.from(assetB, "hex").reverse(),
      liquid.address.toOutputScript(covenantAddress)
    ),
    new liquid.PsetOutput(
      assetBSwapOutAmount,
      Buffer.from(assetB, "hex").reverse(),
      liquid.address.toOutputScript(keypairAddress)
    ),
    new liquid.PsetOutput(
      TRANSACTION_FEE_IN_SATOSHIS,
      Buffer.from(LBTC_ASSET_ID, "hex").reverse(),
      Buffer.alloc(0)
    ),
    new liquid.PsetOutput(
      changeAmount - TRANSACTION_FEE_IN_SATOSHIS,
      Buffer.from(LBTC_ASSET_ID, "hex").reverse(),
      liquid.address.toOutputScript(keypairAddress)
    ),
    new liquid.PsetOutput(
      assetABalance,
      Buffer.from(assetA, "hex").reverse(),
      liquid.address.toOutputScript(keypairAddress)
    ),
  ];

  let pset2 = new Pset(
    new PsetGlobal(2, inputs.length, outputs.length),
    inputs,
    outputs
  );

  signInput(pset2, 2, keypair);
  signInput(pset2, 3, keypair);

  let finalizer2 = new Finalizer(pset2);
  finalizer2.finalize();

  const tx2 = Extractor.extract(pset2);
  const hex2 = tx2.toHex();
  console.log("HEX 2\n\n\n", hex2);

  let txid2 = await client.sendRawTransaction(hex2);
  console.log(txid2);

  let assetAPoolBalance = assetAIssuanceAmount + assetASwapInAmount;
  let assetBPoolBalance = assetBIssuanceAmount - assetBSwapOutAmount;

  let txInfo = {
    txid: txid2,
    assetAPoolBalance,
    assetBPoolBalance,
    assetABalance,
  };

  while (true) {
    txInfo = await makeNewTrade(
      txInfo.txid,
      keypairAddress,
      assetA,
      assetB,
      liquidityPoolScript,
      txInfo.assetAPoolBalance,
      txInfo.assetBPoolBalance,
      covenantAddress,
      client,
      txInfo.assetABalance
    );
  }
}

async function makeNewTrade(
  txid,
  keypairAddress,
  assetA,
  assetB,
  liquidityPoolScript: string,
  assetAPoolBalance,
  assetBPoolBalance,
  covenantAddress,
  client,
  assetABalance
): Promise<any> {
  const prompt = require("prompt-sync")({ sigint: true });
  let assetASwapInAmount = Number(
    prompt("Enter the amount of asset A you'd like to enter? ")
  );
  console.log(`${assetASwapInAmount} of asset A.`);

  function payoutForInput(
    swapOutAssetPoolAmount,
    swapInAssetPoolAmount,
    swapInAssetAmount
  ) {
    return (
      (swapOutAssetPoolAmount * swapInAssetAmount) /
      (swapInAssetPoolAmount + swapInAssetAmount)
    );
  }

  let assetBSwapOutAmount = Math.floor(
    payoutForInput(assetBPoolBalance, assetAPoolBalance, assetASwapInAmount)
  );

  if (assetBSwapOutAmount <= 0) {
    throw new Error(
      `Cannot exchange ${assetASwapInAmount} of asset A for a non-zero amount of asset B`
    );
  }

  let inputs: any[] = [];

  inputs.push(
    createInput2(
      txid,
      0,
      assetA,
      liquidityPoolScript,
      liquid.address.toOutputScript(covenantAddress),
      assetAPoolBalance
    )
  );

  inputs.push(
    createInput2(
      txid,
      1,
      assetB,
      liquidityPoolScript,
      liquid.address.toOutputScript(covenantAddress),
      assetBPoolBalance
    )
  );

  const LBTC_FEE = 10_000;
  let funding: SendResult = await spendToAddress({
    assetId: LBTC_ASSET_ID,
    address: keypairAddress!,
    amount: LBTC_FEE,
  });

  //Funding
  inputs.push(createInput(funding));

  inputs.push(
    createInput2(
      txid,
      5,
      assetA,
      null,
      liquid.address.toOutputScript(keypairAddress),
      assetABalance
    )
  );

  let assetARemaining = assetABalance - assetASwapInAmount;

  let newAssetAPoolBalance = assetAPoolBalance + assetASwapInAmount;
  let newAssetBPoolBalance = assetBPoolBalance - assetBSwapOutAmount;

  if (newAssetAPoolBalance <= 0) {
    throw new Error("new pool a must be gt 0");
  }
  if (newAssetBPoolBalance <= 0) {
    throw new Error("new pool b must be gt 0");
  }
  assetARemaining;

  if (assetARemaining <= 0) {
    throw new Error("assetARemaining must be gt 0");
  }

  let outputs = [
    new liquid.PsetOutput(
      newAssetAPoolBalance,
      Buffer.from(assetA, "hex").reverse(),
      liquid.address.toOutputScript(covenantAddress)
    ),
    new liquid.PsetOutput(
      newAssetBPoolBalance,
      Buffer.from(assetB, "hex").reverse(),
      liquid.address.toOutputScript(covenantAddress)
    ),
    new liquid.PsetOutput(
      assetBSwapOutAmount,
      Buffer.from(assetB, "hex").reverse(),
      liquid.address.toOutputScript(keypairAddress)
    ),
    new liquid.PsetOutput(
      TRANSACTION_FEE_IN_SATOSHIS,
      Buffer.from(LBTC_ASSET_ID, "hex").reverse(),
      Buffer.alloc(0)
    ),
    new liquid.PsetOutput(
      LBTC_FEE - TRANSACTION_FEE_IN_SATOSHIS,
      Buffer.from(LBTC_ASSET_ID, "hex").reverse(),
      liquid.address.toOutputScript(keypairAddress)
    ),
    new liquid.PsetOutput(
      assetARemaining,
      Buffer.from(assetA, "hex").reverse(),
      liquid.address.toOutputScript(keypairAddress)
    ),
  ];

  let pset2 = new Pset(
    new PsetGlobal(2, inputs.length, outputs.length),
    inputs,
    outputs
  );

  signInput(pset2, 2, keypair);
  signInput(pset2, 3, keypair);

  let finalizer2 = new Finalizer(pset2);
  finalizer2.finalize();

  const tx2 = Extractor.extract(pset2);
  const hex2 = tx2.toHex();
  console.log("HEX 2\n\n\n", hex2);

  let txid2 = await client.sendRawTransaction(hex2);

  let assetAExchangeRate = Math.floor(
    payoutForInput(assetBPoolBalance, assetAPoolBalance, 1)
  );

  console.log(`
      assetAPoolAmount: ${assetAPoolBalance}
      assetBPoolAmount: ${assetBPoolBalance},

      assetASwapInAmount: ${assetASwapInAmount},
      assetBSwapOutAmount: ${assetBSwapOutAmount},

      1 asset A = ${assetAExchangeRate} asset B,

      new product: ${
        (assetAPoolBalance + assetASwapInAmount) *
        (assetBPoolBalance - assetBSwapOutAmount)
      }
  `);

  return {
    txid: txid2,
    assetAPoolBalance: newAssetAPoolBalance,
    assetBPoolBalance: newAssetBPoolBalance,
    assetABalance: assetABalance - assetASwapInAmount,
  };
}

main();
