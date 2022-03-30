import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { getLastHeight } from "../services";
import {
  ASTRO_TOKEN,
  BLOCKS_PER_YEAR,
  TERRA_CHAIN_ID,
  TOKENS_WITH_8_DIGITS,
  XASTRO_STAKING_ADDRESS,
} from "../constants";
import { xAstroFee } from "../models/xastro_fee.model";
import { PriceV2 } from "../types/priceV2.type";
import { getContractAddressStore, getLatestBlock } from "../lib/terra";
import { xAstroFeeStat } from "../models/xastro_fee_stat.model";
import { xAstroFeeStatHistory } from "../models/xastro_fee_stat_history.model";

dayjs.extend(utc);

/**
 * Combine fees for the last 24 hours from the xastro_fee table
 * Calculate APR/APY using price data and the amount of xastro staked
 *
 * Caveat: does not work for prices that we don't have.  Ignores those.
 */

export async function aggregateXAstroFees(priceMap: Map<string, PriceV2>): Promise<void> {
  // get latest block height
  const { height, time } = await getLatestBlock();
  const latestHeight = Number(height);

  // TODO switch to 7d
  // get block height 24hrs ago
  const startBlockHeight = latestHeight - Math.floor(BLOCKS_PER_YEAR / 365);

  // sum up the last 24h of xastro_fees
  const day_of_fees = await xAstroFee.find({
    block: { $gt: startBlockHeight, $lt: latestHeight },
  });

  const astro_price = priceMap.get(ASTRO_TOKEN)?.price_ust as number;

  let _24h_fees_ust = 0;
  let fees_with_no_price_count = 0

  for (const fee of day_of_fees) {
    const price = priceMap.get(fee.token)?.price_ust as number;

    if(price != null) {
      let amount = fee.volume;
      // normalize amount
      if (TOKENS_WITH_8_DIGITS.has(fee.token)) {
        amount /= 100;
      }

      amount /= 1000000

      _24h_fees_ust += (price * amount);
    } else {
      fees_with_no_price_count += 1
    }

  }

  console.log("Prices not found for " + fees_with_no_price_count + " fees")

  const total_astro_rewards = _24h_fees_ust / astro_price;

  // calculate apr, apy
  let total_astro_staked = await getContractAddressStore(
    ASTRO_TOKEN,
    '{"balance": { "address": "' + XASTRO_STAKING_ADDRESS + '" }}'
  );

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  total_astro_staked = JSON.parse(total_astro_staked?.Result)?.balance / 1000000;

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const _24h_apr = (365 * total_astro_rewards) / total_astro_staked;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const _24h_apy = Math.pow(1 + (1 + total_astro_rewards) / total_astro_staked, 365);

  await xAstroFeeStatHistory.create({
    block: latestHeight,
    _24h_fees_ust: _24h_fees_ust,
    _24h_apr: _24h_apr,
    _24h_apy: _24h_apy,
  });

  await xAstroFeeStat.updateOne(
    {},
    {
      $set: {
        block: latestHeight,
        _24h_fees_ust: _24h_fees_ust,
        _24h_apr: _24h_apr,
        _24h_apy: _24h_apy,
      },
    },
    { upsert: true }
  );
}
