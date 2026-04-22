// ============================================================
// HOOKKA ERP - Company Constants (Single Source of Truth)
// ============================================================

export const COMPANY = {
  HOOKKA: {
    name: "HOOKKA INDUSTRIES SDN BHD",
    shortName: "HOOKKA INDUSTRIES",
    code: "HOOKKA",
    regNo: "202501060540 (1661946-X)",
    tin: "C60515534080",
    msic: "31009",
    address: "2775F, Jalan Industri 12, Kampung Baru Sungai Buloh, 47000 Sungai Buloh, Selangor",
    addressLines: [
      "2775F, Jalan Industri 12,",
      "Kampung Baru Sungai Buloh,",
      "47000 Sungai Buloh, Selangor",
    ],
    phone: "+6011-6133 3173",
    email: "hookka.industries@gmail.com",
  },
  OHANA: {
    name: "OHANA MARKETING SDN BHD",
    shortName: "OHANA MARKETING",
    code: "OHANA",
    regNo: "202501058806 (1660212-M)",
    tin: "C60508048080",
    msic: "47591",
    address: "The Nest Residence, A-28-07 Jalan A Off, Jalan Puchong, 58200 Kuala Lumpur",
    addressLines: [
      "The Nest Residence, A-28-07",
      "Jalan A Off, Jalan Puchong,",
      "58200 Kuala Lumpur",
    ],
    phone: "+6010-233 1323",
    email: "ohanastudio99@gmail.com",
  },
} as const;

export type CompanyCode = keyof typeof COMPANY;
