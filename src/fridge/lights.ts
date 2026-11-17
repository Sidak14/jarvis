// The lights the home screen may show and switch. This list IS the permission: the page only ever sends one of
// these ids, and the server looks the Home Assistant entity up here, so nothing else can be switched from the screen.

export type LightIcon = "bulb" | "khanda";

export interface Light {
  id: string;
  name: string;
  /** The Home Assistant switch entity. */
  entity: string;
  icon: LightIcon;
  /** Also shown on the home screen (the Lights page shows every light). */
  home: boolean;
  /** Shown but can't be switched from here. */
  locked?: boolean;
}

export const ALL_LIGHTS: Light[] = [
  // `home`: also on the home screen. Everything is on the Lights page.
  { id: "chandelier", name: "Chandelier", entity: "switch.shellyswitch25_c8c9a375a239_channel_1", icon: "bulb", home: true },
  { id: "chandelier-down", name: "Chandelier Down Lights", entity: "switch.shellyswitch25_c8c9a375a239_channel_2", icon: "bulb", home: false },
  { id: "khanda", name: "Khanda Light", entity: "switch.shellyswitch25_c8c9a37a653a_channel_1", icon: "khanda", home: true },
  { id: "entrance", name: "Entrance Lights", entity: "switch.shellyswitch25_c8c9a375c8b2_channel_2", icon: "bulb", home: false },
  { id: "side-lights", name: "Side Lights", entity: "switch.shellyswitch25_c8c9a375c8b2_channel_1", icon: "bulb", home: false },
  { id: "butlers-pantry", name: "Butler's Pantry", entity: "switch.shelly1pm_34945471a117", icon: "bulb", home: true },
  { id: "driveway", name: "Driveway lights", entity: "switch.shelly1pm_34945471ad19", icon: "bulb", home: true },
  { id: "frontyard-bottom", name: "Frontyard Bottom Lights", entity: "switch.shelly1pm_34945472b313", icon: "bulb", home: false },
  { id: "garage", name: "Garage", entity: "switch.shellyswitch25_c45bbe6bd1ee_channel_2", icon: "bulb", home: false },
  { id: "side-garage", name: "Side Garage", entity: "switch.shellyswitch25_c45bbe6bd1ee_channel_1", icon: "bulb", home: false },
  { id: "courtyard", name: "Courtyard Lights", entity: "switch.courtyard_lights", icon: "bulb", home: true },
  { id: "water-fountain", name: "Water Fountain", entity: "switch.water_fountain", icon: "bulb", home: true },
  { id: "backyard-1", name: "Backyard Plug 1", entity: "switch.smart_plug_backyard_1", icon: "bulb", home: true },
  { id: "backyard-2", name: "Backyard Plug 2", entity: "switch.smart_plug_backyard_2", icon: "bulb", home: true },
  // Shown, but never switched: turning it on trips the main circuit (see NEVER_SWITCH).
  { id: "frontyard-top", name: "Frontyard Top Lights", entity: "switch.shellyswitch25_c8c9a37a653a_channel_2", icon: "bulb", home: false, locked: true },
];

/** The lights on the home screen. */
export const LIGHTS: Light[] = ALL_LIGHTS.filter((l) => l.home);

/**
 * Switching these on trips the main circuit (Frontyard Top Lights, Shelly 156 channel 2). They are not in LIGHTS and
 * the Home Assistant client refuses them as well, so adding one to LIGHTS by mistake still cannot switch it.
 */
export const NEVER_SWITCH = ["switch.shellyswitch25_c8c9a37a653a_channel_2"];

export const lightById = (id: string): Light | undefined => ALL_LIGHTS.find((l) => l.id === id);
