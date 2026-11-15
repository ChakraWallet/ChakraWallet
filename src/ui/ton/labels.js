// TON action types with a name of their own in the history (ton.hist.type.<type>); the rest are "other".
export const TON_TYPES = new Set(['contract_deploy', 'call_contract', 'nft_transfer', 'nft_mint', 'jetton_mint', 'jetton_burn', 'stake_deposit', 'stake_withdrawal', 'auction_bid', 'dns_purchase']);
