import cloudbase from '@cloudbase/js-sdk';

window.createCloudBaseApp = (config) => {
  return cloudbase.init(config);
};
