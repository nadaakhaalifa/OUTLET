import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);

/** Structured Egyptian address (data-model addresses.address_ct document). governorate -> city -> district -> street ... */
export const addressSchema = z.object({
  governorateCode: text(16),
  cityCode: text(32).optional(),
  districtCode: text(32).optional(),
  street: text(200),
  building: text(40),
  floor: text(20).optional(),
  apartment: text(20).optional(),
  landmark: text(200).optional(),
  pin: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
});
export type StructuredAddress = z.infer<typeof addressSchema>;

/** COD needs a landmark and a map pin (master prompt 20.7 address quality). */
export function codEligible(address: StructuredAddress): boolean {
  return (address.landmark?.trim().length ?? 0) > 0 && address.pin !== undefined;
}
