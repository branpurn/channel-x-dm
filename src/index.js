// x-dm plugin entry point
import { xDmPlugin } from "./channel.js";

const plugin = {
  id: "x-dm",
  name: "X DM",
  description: "X Direct Message channel (classic DM + opt-in X Chat)",
  register(api) {
    api.registerChannel({ plugin: xDmPlugin });
  },
};

export default plugin;
