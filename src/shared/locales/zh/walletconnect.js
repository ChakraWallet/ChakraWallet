// WalletConnect (Android app): dapps outside the app (a QR code on a computer, a link on the phone) - connecting, who asks
export default {
  'wc.connect.title': '连接此网站',
  'wc.connect.networks': '网络',
  'wc.connect.unsupported.other': '网站请求的 {n} 个网络不在 Chakra 中或已关闭：网站将看不到它们。',
  'wc.connect.noAccount': '此钱包中没有账户在网站要求的所有网络上都有地址。',
  'wc.connect.choose': '选择网站可以看到的账户。在断开连接之前它不会改变。',
  'wc.connect.info': '通过 WalletConnect，网站可以看到该账户的地址，并可请求签名和交易：每个请求都会先在这里显示。可在 设置 › 已连接的网站 中断开连接。',
  'wc.site.verified': '已验证',
  'wc.site.unknown': 'Chakra 无法确认请求来自 {host}：这只是网站自己的声明。仅当这是你亲自打开的网站时才连接。',
  'wc.site.invalid': '<b>注意：</b>请求来自 {origin}，而不是网站声明的 {host}。这可能是仿冒网站。',
  'wc.site.scam': '<b>危险网站。</b>WalletConnect 将 {host} 标记为诈骗：不要连接，也不要签署任何内容。',
  'wc.link.connected': '已连接到 {name}',
  'wc.link.failed': '连接失败：{reason}',
  'wc.err.notLink': '这不是 WalletConnect 连接码。',
  'wc.err.v1': '此代码属于 WalletConnect 1，该版本已于 2023 年停用：网站需要使用版本 2。',
  'wc.err.expired': '代码已过期：请从网站获取新的代码。',
  'wc.err.noProposal': '网站没有发送请求：请从网站获取新的代码后重试。',
};
