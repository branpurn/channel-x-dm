// x-dm plugin entry point
import { xDmPlugin } from "./channel.js";

const plugin = {
  id: "x-dm",
  name: "X DM",
  description: "X (Twitter) Direct Message channel",
  register(api) {
    api.registerChannel({ plugin: xDmPlugin });
  },
};

export default plugin;
