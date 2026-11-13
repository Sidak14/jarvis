// The lights the fridge screen may show and switch. This list IS the permission: the page only ever sends one of
// these ids, and the server looks the Home Assistant entity up here, so nothing else can be switched from the fridge.

export type LightIcon = "bulb" | "khanda";

export interface Light {
  id: string;
  name: string;
  /** The Home Assistant switch entity. */
  entity: string;
  icon: LightIcon;
}

export const LIGHTS: Light[] = [
  { id: "chandelier", name: "Chandelier", entity: "switch.shellyswitch25_c8c9a375a239_channel_1", icon: "bulb" },
  { id: "driveway", name: "Driveway lights", entity: "switch.shelly1pm_34945471ad19", icon: "bulb" },
  { id: "butlers-pantry", name: "Butler's Pantry", entity: "switch.shelly1pm_34945471a117", icon: "bulb" },
  { id: "khanda", name: "Khanda Light", entity: "switch.shellyswitch25_c8c9a37a653a_channel_1", icon: "khanda" },
  { id: "courtyard", name: "Courtyard Lights", entity: "switch.courtyard_lights", icon: "bulb" },
  { id: "water-fountain", name: "Water Fountain", entity: "switch.water_fountain", icon: "bulb" },
  { id: "backyard-1", name: "Backyard Plug 1", entity: "switch.smart_plug_backyard_1", icon: "bulb" },
  { id: "backyard-2", name: "Backyard Plug 2", entity: "switch.smart_plug_backyard_2", icon: "bulb" },
];

/**
 * Switching these on trips the main circuit (Frontyard Top Lights, Shelly 156 channel 2). They are not in LIGHTS and
 * the Home Assistant client refuses them as well, so adding one to LIGHTS by mistake still cannot switch it.
 */
export const NEVER_SWITCH = ["switch.shellyswitch25_c8c9a37a653a_channel_2"];

export const lightById = (id: string): Light | undefined => LIGHTS.find((l) => l.id === id);
