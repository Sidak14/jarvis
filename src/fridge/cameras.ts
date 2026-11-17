// The cameras on the Cameras page: the NVR's six channels through Home Assistant's ONVIF integration. This list IS the
// permission: the page asks for a camera by id and the server looks the Home Assistant entity up here.
// Rename them here (the names are not known to Home Assistant, only "Channel 1" to "Channel 6").

export interface Camera {
  id: string;
  name: string;
  entity: string;
}

export const CAMERAS: Camera[] = [1, 2, 3, 4, 5, 6].map((n) => ({
  id: `cam${n}`,
  name: `Camera ${n}`,
  entity: `camera.dahua_mediaprofile_channel${n}_substream1`,
}));

export const cameraById = (id: string): Camera | undefined => CAMERAS.find((c) => c.id === id);
