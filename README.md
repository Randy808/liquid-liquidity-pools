# liquid-liquidity-pools

Code for the Liquid sidechain that uses the taproot introspection opcodes to setup a simple liquidity pool. The script interface only supports the swap of one asset A for another asset B but the covenant itself should allow for swaps in the other direction.

## Prerequisites
- An elements node running on regtest
- Installation of npm
- Installation of typescript

## How to run
<ol>
<li>Make sure you have an elements node running (use <a href="https://github.com/vulpemventures/nigiri">nigiri</a> to run the script as-is)</li>

<li>Change admin1, 123, and 18881 in the string http://admin1:123@localhost:18881 from ElementsClient.ts to your username, password, and port respectively

<li>Open terminal</li>

<li><code>cd</code> to the folder containing the contents of this repo</li>

<li>Run <code>npm install</code></li>

<li>Run <code>ts-node main.ts</code></li>

<li>The script should ask you to <code>Enter the amount of asset A you'd like to enter</code></li>
</ol>