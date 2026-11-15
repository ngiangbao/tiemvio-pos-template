using System.Security.Cryptography;
using System.Text.Json;

namespace TiemvioPOS;
internal static class UpdateTrust {
    internal static JsonDocument Verify(byte[] data, byte[] signature, RSA key) {
        if (!key.VerifyData(data, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) throw new CryptographicException("Invalid update signature");
        var json = JsonDocument.Parse(data);
        if (json.RootElement.GetProperty("schema").GetInt32() != 1) { json.Dispose(); throw new InvalidDataException("Unknown feed schema"); }
        return json;
    }
    internal static void SelfTest() {
        using var key = RSA.Create(2048);
        byte[] data = System.Text.Encoding.UTF8.GetBytes("{\"schema\":1,\"version\":\"2.0.0\"}");
        byte[] sig = key.SignData(data, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using (var valid = Verify(data, sig, key)) { if (valid.RootElement.GetProperty("version").GetString() != "2.0.0") throw new Exception("Invalid parse"); }
        data[2] ^= 1;
        try { using var bad = Verify(data, sig, key); throw new Exception("Tampered feed accepted"); } catch (CryptographicException) { }
        data[2] ^= 1;
        using var other = RSA.Create(2048);
        try { using var bad = Verify(data, sig, other); throw new Exception("Wrong key accepted"); } catch (CryptographicException) { }
        if (Version.Parse("1.20.0") > Version.Parse("1.20.0.0") || Version.Parse("1.19.9") > Version.Parse("1.20.0.0")) throw new Exception("Version gate failed");
    }
}
