// Keep the app origin and credentials in the DialDev profile.
function selectProfile({ userData, testData }) {
  return { directory: testData || userData, scheme: 'dialdev', vault: 'vault' };
}

module.exports = { selectProfile };
