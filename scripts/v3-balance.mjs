// Prints the free balance (tPOT) of a V3 account. Usage: node scripts/v3-balance.mjs [address]
import { ApiPromise, WsProvider } from "@polkadot/api";

const ADDRESS =
  process.argv[2] ?? "5HSwNUrjU8VqBfdjJdmGdEYig96V1uR6qySiKTZF6eoBd32o";
const WS = process.env.KAIZEN_V3_WS ?? "wss://test-node-v3.portaldot.dev";

const api = await ApiPromise.create({ provider: new WsProvider(WS) });
try {
  const { data } = await api.query.system.account(ADDRESS);
  const decimals = api.registry.chainDecimals[0] ?? 12;
  const free = BigInt(data.free.toString());
  const unit = 10n ** BigInt(decimals);
  const whole = free / unit;
  const frac = (free % unit).toString().padStart(decimals, "0").slice(0, 4);
  console.log(`${ADDRESS} free=${whole}.${frac} tPOT`);
} finally {
  await api.disconnect();
}
process.exit(0);
