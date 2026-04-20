// ============================================================================
// knownFunds — Curated list of well-known ETF tickers
//
// This list exists because SEC's company_tickers.json doesn't distinguish
// operating companies from funds. We combine this with SEC's official mutual
// fund file (company_tickers_mf.json) to get full fund classification.
//
// Mutual funds come from SEC's authoritative list. ETFs are curated here
// because SEC splits ETFs across both files inconsistently.
//
// Update this list as new popular ETFs launch. Organized by category for
// maintainability. Search is case-insensitive — all tickers must be uppercase.
// ============================================================================

export const KNOWN_ETFS = new Set([
  // ==== Broad Market Index ETFs ====
  'SPY', 'IVV', 'VOO', 'VTI', 'ITOT', 'SPLG', 'SCHB', 'VTV', 'VUG', 'VXF',
  'SCHX', 'SCHG', 'SCHV', 'MGK', 'MGV', 'MGC', 'IWB', 'IWF', 'IWD', 'IWM',
  'IWO', 'IWN', 'IJH', 'IJR', 'IJK', 'IJJ', 'IJS', 'IJT', 'VB', 'VBK', 'VBR',
  'VO', 'VOE', 'VOT', 'VV', 'VEA', 'VWO', 'VXUS', 'IEMG', 'IXUS', 'IEFA',
  'ACWI', 'ACWV', 'VEU', 'VSS', 'VT', 'URTH', 'DGRO', 'SCHD', 'VIG', 'DVY',
  'HDV', 'NOBL', 'SDY', 'VYM', 'SPYD', 'RSP', 'QUAL', 'MTUM', 'USMV', 'VLUE',
  'SIZE', 'IWV', 'IOO', 'IYY', 'DIA', 'QQQ', 'QQQM', 'QQQE', 'TQQQ', 'SQQQ',

  // ==== Sector ETFs (SPDR Select Sector, Vanguard, iShares) ====
  'XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLY', 'XLP', 'XLRE', 'XLU', 'XLB',
  'XLC', 'VGT', 'VFH', 'VHT', 'VDE', 'VIS', 'VCR', 'VDC', 'VNQ', 'VPU',
  'VAW', 'VOX', 'IYW', 'IYF', 'IYH', 'IYE', 'IYJ', 'IYC', 'IYK', 'IYR',
  'IDU', 'IYM', 'IYZ', 'FTEC', 'FENY', 'FHLC', 'FSTA', 'FDIS', 'FREL',
  'FUTY', 'FMAT', 'FIDU', 'FCOM', 'SOXX', 'SMH', 'KRE', 'KBE', 'IHI',
  'IBB', 'XBI', 'XME', 'XHB', 'XRT', 'ITB', 'JETS', 'KIE', 'KCE',

  // ==== International / Regional ETFs ====
  'EWJ', 'EWZ', 'EWG', 'EWU', 'EWC', 'EWA', 'EWW', 'EWP', 'EWQ', 'EWH',
  'EWT', 'EWY', 'EWS', 'EWI', 'EWD', 'EWL', 'EWN', 'EWK', 'EWO', 'EPHE',
  'EPOL', 'EIDO', 'ECH', 'EZA', 'EPI', 'INDA', 'MCHI', 'FXI', 'GXC', 'KWEB',
  'YINN', 'YANG', 'ASHR', 'CQQQ', 'EMB', 'PCY', 'LEMB', 'VWOB', 'EEMV',
  'EEM', 'EFAV', 'EFA', 'SCZ', 'IEUR', 'IPAC', 'ILF', 'EIRL', 'NORW',
  'TUR', 'GREK', 'ARGT',

  // ==== Fixed Income / Bond ETFs ====
  'BND', 'AGG', 'BNDX', 'VCIT', 'VCSH', 'VCLT', 'VGIT', 'VGSH', 'VGLT',
  'VMBS', 'VTEB', 'MUB', 'HYG', 'LQD', 'JNK', 'TLT', 'TLH', 'IEF', 'IEI',
  'SHY', 'BIL', 'SHV', 'GOVT', 'GBIL', 'FLOT', 'VRIG', 'MBB', 'STIP',
  'TIP', 'SCHO', 'SCHR', 'SCHZ', 'SCHP', 'SPTL', 'SPTI', 'SPTS', 'SPIP',
  'SPAB', 'SPHY', 'SPSB', 'SPIB', 'SPLB', 'PULS', 'FLTR', 'FLRN', 'BSV',
  'BIV', 'BLV', 'SUB', 'TFI', 'ICSH', 'NEAR', 'JPST', 'GSY', 'MINT',
  'EMLC', 'PCY', 'EMB', 'HYD', 'HYMB', 'ANGL', 'BKLN', 'SRLN', 'FALN',

  // ==== Commodity ETFs ====
  'GLD', 'IAU', 'SGOL', 'BAR', 'SLV', 'SIVR', 'USO', 'UCO', 'SCO', 'BNO',
  'UNG', 'UNL', 'BOIL', 'KOLD', 'DBA', 'DBB', 'DBC', 'DBO', 'DBE', 'DBP',
  'PPLT', 'PALL', 'JJG', 'JJC', 'JJN', 'JJU', 'JO', 'NIB', 'SGG', 'BAL',
  'CORN', 'WEAT', 'SOYB', 'CANE', 'COW', 'UGL', 'AGQ', 'DGP', 'DZZ',
  'GLL', 'DGZ', 'GDX', 'GDXJ', 'SIL', 'SILJ', 'COPX', 'LIT', 'REMX',

  // ==== Crypto ETFs ====
  // Spot Bitcoin ETFs
  'IBIT', 'FBTC', 'ARKB', 'BITB', 'GBTC', 'HODL', 'BRRR', 'BTCO', 'BTCW', 'EZBC',
  'DEFI',
  // Spot Ethereum ETFs
  'ETHA', 'FETH', 'ETHE', 'ETH', 'QETH', 'CETH', 'EZET', 'ETHV', 'ETHW',
  // Crypto-adjacent thematic
  'BITQ', 'BLOK', 'BLCN', 'LEGR', 'SATO', 'DAPP', 'BITO', 'BTF', 'XBTF', 'BITI',

  // ==== Dividend / Income ETFs ====
  'SDIV', 'DIV', 'DGRO', 'FDVV', 'FVD', 'NOBL', 'REGL', 'SMDV', 'SPYD',
  'SPHD', 'HDV', 'DVY', 'VIG', 'VYM', 'DGRW', 'DON', 'DEM', 'DES', 'DLN',
  'DTN', 'DTD', 'DHS', 'RDVY', 'VIGI', 'VYMI', 'DWX', 'IDV', 'PID', 'PEY',

  // ==== Thematic / Innovation ETFs ====
  'ARKK', 'ARKG', 'ARKQ', 'ARKW', 'ARKF', 'ARKX', 'PRNT', 'IZRL', 'ICLN',
  'TAN', 'FAN', 'PBW', 'QCLN', 'ACES', 'SMOG', 'LIT', 'DRIV', 'IDRV',
  'KARS', 'HAIL', 'ROBO', 'BOTZ', 'ROBT', 'UBOT', 'IRBO', 'HERO', 'ESPO',
  'GAMR', 'NERD', 'METV', 'MTVR', 'ROUNDHILL', 'MAGS', 'IYLD', 'CWEB',
  'WCLD', 'CLOU', 'SKYY', 'WEBL', 'WEBS', 'IGV', 'FDN', 'PSJ', 'QTUM',

  // ==== Leveraged / Inverse ETFs ====
  'TQQQ', 'SQQQ', 'SPXL', 'SPXS', 'SSO', 'SDS', 'UPRO', 'SPXU', 'UDOW',
  'SDOW', 'TNA', 'TZA', 'URTY', 'SRTY', 'TMF', 'TMV', 'FAS', 'FAZ', 'LABU',
  'LABD', 'NUGT', 'DUST', 'JNUG', 'JDST', 'GUSH', 'DRIP', 'ERX', 'ERY',
  'CURE', 'RXD', 'SOXL', 'SOXS', 'TECL', 'TECS', 'WEBL', 'WEBS', 'DFEN',
  'BITU', 'BITX', 'ETHU', 'ETHT',

  // ==== Volatility / Hedging ETFs ====
  'VXX', 'VXZ', 'UVXY', 'SVXY', 'VIXY', 'VIXM', 'TAIL', 'SWAN', 'BTAL',
  'HDGE', 'RLY', 'PFIX', 'FTLS',

  // ==== Factor / Smart Beta ETFs ====
  'QUAL', 'MTUM', 'USMV', 'VLUE', 'SIZE', 'EEMV', 'EFAV', 'ACWV', 'SPMO',
  'SPMB', 'SPHB', 'SPLV', 'XMLV', 'XSLV', 'VFMF', 'VFLQ', 'VFMO', 'VFQY',
  'VFMV', 'ONEQ', 'PDP', 'PRF', 'PRFZ', 'PXF', 'PXH', 'DWAS', 'FDM',

  // ==== Real Estate ETFs ====
  'VNQ', 'SCHH', 'IYR', 'XLRE', 'RWR', 'ICF', 'REM', 'MORT', 'KBWY',
  'SRET', 'PFFR', 'VNQI', 'RWX', 'IFGL', 'NETL', 'INDS', 'DRN', 'DRV',

  // ==== Preferred / Convertible / Specialty Income ====
  'PFF', 'PFFD', 'PSK', 'PFFA', 'PGX', 'PFXF', 'CWB', 'ICVT',

  // ==== Currency ETFs ====
  'UUP', 'UDN', 'FXE', 'FXY', 'FXB', 'FXC', 'FXA', 'FXF', 'CYB', 'CEW',

  // ==== ESG / Clean Energy ====
  'ESGU', 'ESGV', 'ESGE', 'ESGD', 'SUSA', 'SUSL', 'DSI', 'KLD', 'CRBN',
  'LOWC', 'CNRG', 'ICLN', 'PBW', 'QCLN', 'TAN', 'FAN', 'PBD', 'GRID',
  'SMOG', 'NLR', 'URA', 'URNM', 'HYDR',

  // ==== Defined Outcome / Buffered ETFs ====
  'JEPI', 'JEPQ', 'XYLD', 'QYLD', 'RYLD', 'DIVO', 'SPYI', 'QQQI', 'BALI',
  'NUSI', 'SVOL', 'PAPI', 'FEPI', 'GPIQ', 'GPIX',

  // ==== Ark, Roundhill, WisdomTree, and other boutique ====
  'WTV', 'WLDR', 'DGRW', 'DGRE', 'DGRS', 'DXJ', 'HEDJ', 'DFE', 'EPS',
  'EES', 'EZM', 'EZA', 'MAGS', 'SMRT', 'ROOF', 'XT',

  // ==== New / Trending (as of 2025-2026) ====
  'MSTU', 'MSTX', 'NVDX', 'NVDL', 'NVDD', 'TSLL', 'TSLQ', 'TSLZ', 'CONL',
  'AAPU', 'AAPD', 'MSFU', 'MSFD', 'AMZU', 'AMZD', 'GGLL', 'GGLS', 'METU',
  'METD', 'AIQ', 'CHAT', 'ROBO', 'BOTZ', 'AIYY', 'MSTY', 'NVDY', 'CONY',
  'TSLY', 'AMDY', 'PLTY', 'YMAX', 'YMAG', 'ULTY', 'FBY', 'NFLY', 'DISO',
]);

/**
 * Check if a ticker is a known fund (ETF).
 * Combines with SEC's mutual fund file to give full fund classification.
 *
 * @param {string} ticker - Uppercase ticker symbol
 * @returns {boolean}
 */
export function isKnownETF(ticker) {
  if (!ticker) return false;
  return KNOWN_ETFS.has(ticker.toUpperCase());
}
