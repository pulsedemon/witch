export default (api) => ({
  babelrc: false,
  plugins: [
    [
      'babel-plugin-react-compiler',
      { panicThreshold: api.env('lint') ? 'all_errors' : 'none' },
    ],
  ],
  presets: [
    ['@babel/preset-typescript', { onlyRemoveTypeImports: true }],
    ['@babel/preset-react', { runtime: 'automatic' }],
  ],
});
