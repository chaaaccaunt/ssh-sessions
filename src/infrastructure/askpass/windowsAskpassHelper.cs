using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Web.Script.Serialization;

internal static class WindowsAskpassHelper
{
    private const string PipePrefix = @"\\.\pipe\";

    private sealed class BrokerResponse
    {
        public bool ok { get; set; }
        public string value { get; set; }
    }

    public static int Main(string[] args)
    {
        byte[] secret = null;

        try
        {
            string endpoint = Environment.GetEnvironmentVariable("SSH_SESSION_ASKPASS_ENDPOINT");
            string token = Environment.GetEnvironmentVariable("SSH_SESSION_ASKPASS_TOKEN");

            if (String.IsNullOrEmpty(endpoint) || String.IsNullOrEmpty(token))
            {
                return 1;
            }

            string pipeName = endpoint.StartsWith(PipePrefix, StringComparison.OrdinalIgnoreCase)
                ? endpoint.Substring(PipePrefix.Length)
                : endpoint;
            string prompt = args.Length > 0 ? args[0] : String.Empty;

            using (NamedPipeClientStream pipe = new NamedPipeClientStream(
                ".",
                pipeName,
                PipeDirection.InOut,
                PipeOptions.None))
            {
                pipe.Connect(15000);

                JavaScriptSerializer serializer = new JavaScriptSerializer();
                string request = serializer.Serialize(new Dictionary<string, string>
                {
                    { "token", token },
                    { "prompt", prompt }
                });
                UTF8Encoding encoding = new UTF8Encoding(false);

                using (StreamWriter writer = new StreamWriter(pipe, encoding, 1024, true))
                using (StreamReader reader = new StreamReader(pipe, encoding, false, 1024, true))
                {
                    writer.WriteLine(request);
                    writer.Flush();

                    string responseText = reader.ReadLine();
                    BrokerResponse response = responseText == null
                        ? null
                        : serializer.Deserialize<BrokerResponse>(responseText);

                    if (response == null || !response.ok || String.IsNullOrEmpty(response.value))
                    {
                        return 1;
                    }

                    secret = Convert.FromBase64String(response.value);
                }
            }

            using (Stream output = Console.OpenStandardOutput())
            {
                output.Write(secret, 0, secret.Length);
                output.WriteByte((byte)'\n');
                output.Flush();
            }

            return 0;
        }
        catch
        {
            return 1;
        }
        finally
        {
            if (secret != null)
            {
                Array.Clear(secret, 0, secret.Length);
            }
        }
    }
}
