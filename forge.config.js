const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
    packagerConfig: {
        asar: true,
        appBundleId: 'com.where.browser',
        appCategoryType: 'public.app-category.productivity',
        win32metadata: {
            CompanyName: 'Where Browser',
            FileDescription: 'Where - Navigate the web with purpose',
            OriginalFilename: 'Where.exe',
            ProductName: 'Where',
            InternalName: 'Where'
        },
        osxSign: false,
        icon: 'assets/icon',
        buildVersion: '1.0.0'
    },
    makers: [
        {
            name: '@electron-forge/maker-squirrel',
            config: {
                name: 'where',
                title: 'Where Browser',
                authors: 'chance',
                exe: 'Where.exe',
                setupExe: 'WhereSetup.exe',
                setupIcon: 'assets/icon.ico',
                iconUrl: 'https://raw.githubusercontent.com/yourusername/where-browser/main/assets/icon.ico'
            }
        },
        {
            name: '@electron-forge/maker-zip',
            platforms: ['darwin', 'linux', 'win32']
        },
        {
            name: '@electron-forge/maker-deb',
            config: {
                options: {
                    maintainer: 'chance',
                    homepage: 'https://github.com/yourusername/where-browser',
                    icon: 'assets/icon.png',
                    categories: ['Network', 'WebBrowser'],
                    description: 'Where - Navigate the web with purpose'
                }
            }
        },
        {
            name: '@electron-forge/maker-rpm',
            config: {
                options: {
                    name: 'where-browser',
                    productName: 'Where',
                    homepage: 'https://github.com/yourusername/where-browser',
                    license: 'MIT',
                    categories: ['Network', 'WebBrowser'],
                    description: 'Where - Navigate the web with purpose',
                    icon: 'assets/icon.png'
                }
            }
        }
    ],
    plugins: [
        {
            name: '@electron-forge/plugin-auto-unpack-natives',
            config: {}
        },
        new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true
        })
    ]
};
