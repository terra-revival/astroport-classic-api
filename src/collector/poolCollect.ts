import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);

import { getContractAddressStore, getContractStore, getPairLiquidity } from "../lib/terra";
import { getBlock, getHeight, getPairs, getPriceByPairId, insertSupply } from "../services";
import { ASTRO_YEARLY_EMISSIONS, FEES, TOKEN_ADDRESS_MAP, TERRA_CHAIN_ID } from "../constants";
import { insertPoolTimeseries } from "../services/pool_timeseries.service";
import { PoolTimeseries } from "../models/pool_timeseries.model";
import { PoolVolume24h } from "../models/pool_volume_24hr.model";
import { PoolProtocolRewardVolume24h } from "../models/pool_protocol_reward_volume_24hr.model";
import { getPricesFromPool } from "../modules/terra";

/**
 * Update the pool_timeseries table every minute.
 */

const DIGITS = 1000000;
const chainId = TERRA_CHAIN_ID;
const BLOCKS_PER_YEAR = 4656810

const ASTRO_PAIR_ADDRESS = "terra1l7xu2rl3c7qmtx3r5sd2tz25glf6jh8ul7aag7"

// TODO make this more legible
// TODO double check math
export async function poolCollect(): Promise<void> {

  // get all pairs
  const pairs = await getPairs()
  console.log("Pairs length: " + pairs.length)
  for (const pair of pairs) {
    console.log(pair + ": " + pair.contractAddr)


    const result = new PoolTimeseries();

    const pool_liquidity = await getPairLiquidity(pair.contractAddr, JSON.parse('{ "pool": {} }'))

    if (pool_liquidity < 1000) continue



    let pool_type: string = pair.type
    // TODO temp fix for bluna/luna => use stable, not xyk
    if(pair.contractAddr == "terra1j66jatn3k50hjtg2xemnjm8s7y8dws9xqa5y8w") { // bluna luna
      pool_type = "stable"
    }

    const dayVolumeResponse = await PoolVolume24h.findOne({ pool_address: pair.contractAddr })
    const dayVolume = dayVolumeResponse._24h_volume // in UST

    const trading_fee_bp = FEES.get(pool_type) ?? 20 // basis points
    const trading_fee_perc = trading_fee_bp / 10000 // percentage

    result.timestamp = dayjs().valueOf()
    result.metadata.pool_type = pool_type
    result.metadata.trading_fee_rate_bp = FEES.get(pool_type)
    result.metadata.pool_address = pair.contractAddr
    result.metadata.pool_liquidity = pool_liquidity
    result.metadata.day_volume_ust = dayVolume

    // TODO - temporary solution
    if (TOKEN_ADDRESS_MAP.get(pair.contractAddr)) {
      console.log("Saving token name for: " + pair.contractAddr + ": " + TOKEN_ADDRESS_MAP.get(pair.contractAddr))
      result.metadata.token_symbol = TOKEN_ADDRESS_MAP.get(pair.contractAddr)
    }

    // trading fees
    result.metadata.fees.trading.day = trading_fee_perc * dayVolume // 24 hour fee amount, not rate
    result.metadata.fees.trading.apr = ((trading_fee_perc * dayVolume * 365) / pool_liquidity)
    result.metadata.fees.trading.apy = Math.pow((1 + (trading_fee_perc * dayVolume) / pool_liquidity), 365) - 1

    // generator rewards
    let astro_price = await getPriceByPairId(ASTRO_PAIR_ADDRESS)
    astro_price = astro_price.token1

    let astro_yearly_emission = ASTRO_YEARLY_EMISSIONS.get(pair.contractAddr) ?? 0
    astro_yearly_emission = astro_yearly_emission * astro_price
    result.metadata.fees.astro.day = astro_yearly_emission / 365 // 24 hour fee amount, not rate
    result.metadata.fees.astro.apr = astro_yearly_emission / pool_liquidity
    result.metadata.fees.astro.apy = Math.pow((1 + (astro_yearly_emission / 365) / pool_liquidity), 365) - 1

    // protocol rewards - like ANC for ANC-UST
    const protocolRewardsRaw = await PoolProtocolRewardVolume24h.findOne({ pool_address: pair.contractAddr }) ?? { volume: 0 }
    let protocolRewards = Number(protocolRewardsRaw.volume) / 1000000
    // for orion.  TODO
    if (pair.contractAddr == "terra1mxyp5z27xxgmv70xpqjk7jvfq54as9dfzug74m") {
      protocolRewards = protocolRewards / 100
    }
    const nativeToken = await getPriceByPairId(pair.contractAddr) // TODO something's off here for bluna/luna
    let nativeTokenPrice = nativeToken.token1
    // for orion.  TODO
    if (pair.contractAddr == "terra1mxyp5z27xxgmv70xpqjk7jvfq54as9dfzug74m") {
      nativeTokenPrice = nativeTokenPrice * 100
    }


    result.metadata.fees.native.day = protocolRewards * nativeTokenPrice // 24 hour fee amount, not rate
    result.metadata.fees.native.apr = (protocolRewards * nativeTokenPrice * 365) / pool_liquidity
    // note: can overflow to Infinity
    result.metadata.fees.native.apy = Math.pow((1 + (protocolRewards * nativeTokenPrice) / pool_liquidity), 365) - 1

    // total
    result.metadata.fees.total.day =
      result.metadata.fees.trading.day +
      result.metadata.fees.astro.day +
      result.metadata.fees.native.day

    result.metadata.fees.total.apr = (result.metadata.fees.total.day * 365) / pool_liquidity
    result.metadata.fees.total.apy = Math.pow((1 + result.metadata.fees.total.day / pool_liquidity), 365) - 1


    await insertPoolTimeseries(result)

  }
}
