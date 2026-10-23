export default {
  babelrc: false,
  plugins: ['babel-plugin-react-compiler'],
  presets: [
    ['@babel/preset-typescript', { onlyRemoveTypeImports: true }],
    ['@babel/preset-react', { runtime: 'automatic' }],
  ],
};
