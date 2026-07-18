using Bit.Api.Vault.Models;
using Bit.SharedWeb.Swagger;
using Microsoft.Extensions.DependencyInjection;
using Swashbuckle.AspNetCore.SwaggerGen;
using Xunit;

namespace Bit.Api.Test.Vault.Models;

public class CipherFido2CredentialModelTests
{
    [Fact]
    public void OpenApiSchema_ExposesOptionalExtensionState()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSwaggerGen(options => options.SchemaFilter<EncryptedStringSchemaFilter>());
        using var serviceProvider = services.BuildServiceProvider();
        var schemaGenerator = serviceProvider.GetRequiredService<ISchemaGenerator>();
        var repository = new SchemaRepository();

        schemaGenerator.GenerateSchema(typeof(CipherFido2CredentialModel), repository);

        var schema = repository.Schemas[nameof(CipherFido2CredentialModel)];
        Assert.Contains("extensionState", schema.Properties.Keys);
        Assert.DoesNotContain("extensionState", schema.Required);
        Assert.Equal("x-enc-string", schema.Properties["extensionState"].Format);
        Assert.Equal(10000, schema.Properties["extensionState"].MaxLength);
    }
}
